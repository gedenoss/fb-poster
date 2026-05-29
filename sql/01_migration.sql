-- =========================================================================
-- Facebook Group Posting — Schema Migration
-- =========================================================================
-- Adds the tables required by the FB-group posting worker.
-- Designed to coexist with the existing Wellow schema (uses `property`,
-- `vw_property_article`, `room` for the post payload).
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1) Facebook groups catalogue
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fb_groups (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    url         text NOT NULL UNIQUE,
    city        text,                       -- optional: target groups per city
    active      boolean NOT NULL DEFAULT true,
    is_test     boolean NOT NULL DEFAULT false,   -- ← test vs prod switch
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fb_groups IS 'Facebook groups in which the bot publishes property ads.';
COMMENT ON COLUMN public.fb_groups.is_test IS 'When TEST_MODE=true on worker, only is_test=true groups are used.';
COMMENT ON COLUMN public.fb_groups.url IS 'Canonical group URL, e.g. https://www.facebook.com/groups/123456789';

-- -------------------------------------------------------------------------
-- 2) Posting jobs (one per property_id received from the frontend)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fb_posting_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id     uuid NOT NULL REFERENCES public.property(id) ON DELETE CASCADE,
    status          text NOT NULL DEFAULT 'queued'
                       CHECK (status IN (
                          'queued',
                          'running',
                          'needs_login',  -- ← cookies dead, waiting for human re-auth
                          'completed',
                          'failed',
                          'partial'
                       )),
    requested_by    uuid,                   -- optional: member.id of requester
    created_at      timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    finished_at     timestamptz,
    error           text,
    result          jsonb                    -- final per-group summary
);

CREATE INDEX IF NOT EXISTS idx_fb_jobs_status   ON public.fb_posting_jobs(status);
CREATE INDEX IF NOT EXISTS idx_fb_jobs_property ON public.fb_posting_jobs(property_id);

COMMENT ON TABLE public.fb_posting_jobs IS 'Queue of FB-posting jobs consumed by the persistent worker.';

-- -------------------------------------------------------------------------
-- 3) Posts published in groups (one row per group, per property)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fb_group_posts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id     uuid NOT NULL REFERENCES public.property(id) ON DELETE CASCADE,
    group_id        uuid NOT NULL REFERENCES public.fb_groups(id) ON DELETE CASCADE,
    job_id          uuid REFERENCES public.fb_posting_jobs(id) ON DELETE SET NULL,
    post_url        text,                   -- canonical FB post URL once published
    status          text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','published','failed','deleted')),
    error           text,
    published_at    timestamptz,
    deleted_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fb_posts_property ON public.fb_group_posts(property_id);
CREATE INDEX IF NOT EXISTS idx_fb_posts_status   ON public.fb_group_posts(status);
CREATE INDEX IF NOT EXISTS idx_fb_posts_group    ON public.fb_group_posts(group_id);

COMMENT ON TABLE public.fb_group_posts IS 'Tracks each post published in a FB group so it can later be deleted.';

-- -------------------------------------------------------------------------
-- 4) Structured action log (traceability + UI display)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fb_action_logs (
    id          bigserial PRIMARY KEY,
    job_id      uuid REFERENCES public.fb_posting_jobs(id) ON DELETE CASCADE,
    group_id    uuid REFERENCES public.fb_groups(id) ON DELETE SET NULL,
    level       text NOT NULL CHECK (level IN ('info','warn','error','debug')),
    action      text NOT NULL,
    message     text,
    meta        jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fb_logs_job   ON public.fb_action_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_fb_logs_level ON public.fb_action_logs(level);

-- -------------------------------------------------------------------------
-- 5) Session state singleton (used to track when the session is bad
--    and to signal that someone is currently re-logging-in)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fb_session_state (
    id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- enforces singleton
    status        text NOT NULL DEFAULT 'unknown'
                     CHECK (status IN ('ok','needs_login','relogging_in','unknown')),
    last_check_at timestamptz,
    last_ok_at    timestamptz,
    last_error    text,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.fb_session_state (id, status)
VALUES (1, 'unknown')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.fb_session_state IS
  'Global FB-session health. Frontend reads this to show "Session expired — Re-login" CTA.';

-- -------------------------------------------------------------------------
-- 6) Property pricing — flat view for the worker
-- -------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_fb_property_payload;
CREATE VIEW public.v_fb_property_payload
WITH (security_invoker = true) AS
SELECT DISTINCT ON (p.id)
    p.id                                          AS property_id,
    COALESCE(p.marketing_name, p.name)            AS title,
    p.city                                        AS city,
    p.address                                     AS address,
    p.surface                                     AS surface_m2,
    p.bedroom_number                              AS bedrooms,
    p.image                                       AS cover_image,
    p.available_room_for_sales                    AS available_rooms,
    (
        SELECT MIN(r.rent)
        FROM   public.room r
        WHERE  r.property_id = p.id
          AND  r.rent IS NOT NULL
          AND  r.rent > 0
    )                                             AS price_from,
    CASE
        WHEN p.city = ANY (ARRAY[
            'Suresnes', 'Saint-Denis', 'Puteaux', 'Neuilly-Sur-Seine',
            'Montreuil', 'Levallois-Perret', 'Issy-les-Moulineaux',
            'Courbevoie', 'Clichy', 'Boulogne-Billancourt',
            'Asnières-Sur-Seine', 'Aulnay-Sous-Bois'
        ]::text[])
        THEN 'Paris'::text
        ELSE p.city
    END                                           AS zone,
    bedrooms_photos.bedroom_1                     AS bedroom_photo_1,
    bedrooms_photos.bedroom_2                     AS bedroom_photo_2,
    bedrooms_photos.bedroom_3                     AS bedroom_photo_3,
    kitchen_photo.link                            AS kitchen_photo,
    living_room_photo.link                        AS living_room_photo
FROM public.property p
LEFT JOIN LATERAL (
    SELECT
        MAX(CASE WHEN rn = 1 THEN link END) AS bedroom_1,
        MAX(CASE WHEN rn = 2 THEN link END) AS bedroom_2,
        MAX(CASE WHEN rn = 3 THEN link END) AS bedroom_3
    FROM (
        SELECT vc.link, ROW_NUMBER() OVER (ORDER BY vc.timestamp DESC) AS rn
        FROM public.visual_content vc
        LEFT JOIN public.room r2 ON r2.id = vc.room_id
        WHERE (vc.property_id = p.id OR r2.property_id = p.id)
          AND vc.description = 'bedroom'
          AND vc.link IS NOT NULL
    ) ranked
    WHERE rn <= 3
) bedrooms_photos ON true
LEFT JOIN LATERAL (
    SELECT vc.link
    FROM public.visual_content vc
    LEFT JOIN public.room r2 ON r2.id = vc.room_id
    WHERE (vc.property_id = p.id OR r2.property_id = p.id)
      AND vc.description = 'kitchen'
      AND vc.link IS NOT NULL
    ORDER BY vc.timestamp DESC
    LIMIT 1
) kitchen_photo ON true
LEFT JOIN LATERAL (
    SELECT vc.link
    FROM public.visual_content vc
    LEFT JOIN public.room r2 ON r2.id = vc.room_id
    WHERE (vc.property_id = p.id OR r2.property_id = p.id)
      AND vc.description = 'living_room'
      AND vc.link IS NOT NULL
    ORDER BY vc.timestamp DESC
    LIMIT 1
) living_room_photo ON true
ORDER BY p.id;

COMMENT ON VIEW public.v_fb_property_payload IS
  'Flat payload consumed by the FB-posting worker to build the post text.';

-- -------------------------------------------------------------------------
-- 7) Storage bucket for browser session state
-- -------------------------------------------------------------------------
--   Run once via dashboard or:
--     INSERT INTO storage.buckets (id, name, public)
--     VALUES ('fb-sessions', 'fb-sessions', false)
--     ON CONFLICT DO NOTHING;
-- -------------------------------------------------------------------------

-- -------------------------------------------------------------------------
-- 8) RLS
-- -------------------------------------------------------------------------
ALTER TABLE public.fb_groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_posting_jobs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_group_posts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_action_logs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_session_state ENABLE ROW LEVEL SECURITY;
-- No public policies — worker uses the service_role key.
