# Facebook Group Poster — Wellow

Bot qui publie un bien Wellow dans des groupes Facebook depuis l'outil
interne. Pas de Docker, pas de VPS, hébergement Render gratuit.

```
 ┌──────────────────┐    POST {property_id}    ┌────────────────┐
 │  Outil interne   │ ────────────────────────▶│ Edge Function  │
 │   (frontend)     │                          │  (Supabase)    │
 └──────────────────┘                          └───────┬────────┘
        ▲                                              │ INSERT job
        │ GET /status                                  ▼
        │                                       ┌─────────────┐
        │                                       │  Postgres   │
        │                                       └──────┬──────┘
        │                                              │
        │                                       ┌──────┴──────────┐
        │                                       │  Worker Render  │
        │                                       │  Node+Playwright│
        │                                       └──────┬──────────┘
        │                                              │
        └──────── needs_login ?                        │ post / delete
                  → ouvrir /relogin ───────────▶ facebook.com
```

---

## TL;DR

1. `psql -f sql/01_migration.sql` (créer tables + bucket)
2. Déployer le worker sur **Render free** (1 clic via `render.yaml`)
3. Déployer l'Edge Function Supabase
4. Insérer **un** groupe test : `INSERT INTO fb_groups (name, url, is_test) VALUES (...)`
5. Première utilisation : l'outil interne reçoit `needs_login` → la personne ouvre `/relogin`, tape email/password du compte FB → c'est parti.

`TEST_MODE=true` (par défaut) limite le bot aux groupes marqués `is_test=true`. Une fois validé, mettre `TEST_MODE=false` côté Render.

---

## Arborescence

```
.
├── edge-function/        # Supabase Edge Function (entrée HTTP)
│   └── index.ts
├── sql/
│   └── 01_migration.sql  # tables, vue, bucket
├── worker/               # Node.js + Playwright (héberge aussi /relogin)
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── index.js              # Express + boucle de polling
│       ├── config.js
│       ├── public/
│       │   └── relogin.html      # page de reconnexion (servie par le worker)
│       ├── modules/
│       │   ├── db.js
│       │   ├── session.js        # state.json local + Supabase Storage
│       │   ├── browser.js
│       │   ├── images.js
│       │   ├── content.js
│       │   ├── facebook.js       # automation FB (post / delete / login)
│       │   ├── relogin.js        # orchestre la re-auth depuis le formulaire
│       │   └── orchestrator.js   # exécute un job de bout en bout
│       └── utils/
│           ├── human.js
│           ├── retry.js
│           ├── logger.js
│           └── notify.js         # Slack webhook (optionnel)
├── render.yaml           # déploiement Render free, sans Docker
└── README.md
```

---

## 1. Base de données

Dans Supabase SQL Editor :

```sql
-- copier-coller le contenu de sql/01_migration.sql
```

Puis créer le bucket (Storage → New bucket → `fb-sessions` → **private**), ou
en SQL :

```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('fb-sessions', 'fb-sessions', false)
ON CONFLICT DO NOTHING;
```

Insérer **un seul** groupe pour la phase test (n'importe quel groupe FB où
le compte test est membre — pas besoin d'être admin) :

```sql
INSERT INTO fb_groups (name, url, city, is_test, active) VALUES
('Groupe test', 'https://www.facebook.com/groups/XXXXXXXXX', NULL, true, true);
```

---

## 2. Edge Function

Depuis le repo Supabase de Wellow :

```bash
# créer le dossier de la fonction si pas existant
mkdir -p supabase/functions/run-posting-job
cp edge-function/index.ts supabase/functions/run-posting-job/index.ts

# déployer
supabase functions deploy run-posting-job --no-verify-jwt
```

Définir les secrets (Dashboard Supabase → Edge Functions → Secrets) :

| Var                          | Valeur                                                |
|------------------------------|-------------------------------------------------------|
| `SUPABASE_URL`               | `https://<ref>.supabase.co`                           |
| `SUPABASE_SERVICE_ROLE_KEY`  | clé service-role                                      |
| `WORKER_URL`                 | `https://fb-group-poster.onrender.com/trigger`        |
| `WORKER_PUBLIC_URL`          | `https://fb-group-poster.onrender.com`                |
| `WORKER_SECRET`              | même valeur que dans Render (`WORKER_SECRET`)         |

### Endpoints exposés

| Méthode | URL                                             | Description                                |
|---------|-------------------------------------------------|--------------------------------------------|
| POST    | `/run-posting-job`                              | Enqueue un job pour un `property_id`       |
| GET     | `/run-posting-job/status?job_id=<uuid>`         | Statut d'un job (à poller)                 |
| GET     | `/run-posting-job/session`                      | Santé de la session FB (`ok` / `needs_login`) |

Côté outil interne, le bouton "Publier" fait :

```js
const res = await fetch('https://<ref>.functions.supabase.co/run-posting-job', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ property_id: 'xxx' }),
})
const { status, job_id, relogin_url } = await res.json()

if (status === 'needs_login' && relogin_url) {
  // Ouvre la page de reconnexion dans un nouvel onglet
  window.open(relogin_url, '_blank')
}
```

Et pour suivre l'avancement :

```js
const r = await fetch(`.../run-posting-job/status?job_id=${job_id}`)
const { status, result, relogin_url } = await r.json()
// status ∈ queued | running | needs_login | completed | partial | failed
```

---

## 3. Worker — déploiement Render free

1. Pousser ce repo sur GitHub.
2. Render → **New +** → **Blueprint** → sélectionner le repo.
3. Render lit `render.yaml`, demande les secrets manquants :
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SLACK_WEBHOOK_URL` *(optionnel)*
4. Après le premier déploiement :
   - Noter l'URL Render (ex. `https://fb-group-poster.onrender.com`)
   - Aller dans **Environment** du service Render → définir `PUBLIC_BASE_URL` à cette URL
   - Récupérer `WORKER_SECRET` et `RELOGIN_TOKEN` générés et les passer à l'Edge Function
   - Redémarrer le service

Tester :

```bash
curl https://fb-group-poster.onrender.com/healthz
# → { "ok": true, "busy": false, "session": "unknown" }
```

> ⚠️ Render free **endort** le service après 15 min sans trafic. Le premier
> appel après réveil met 30–60 s — l'Edge Function gère ça (elle insère
> juste le job en DB, le worker se réveille au prochain poll).

---

## 4. Premier login

C'est la seule étape humaine. Avant le tout premier post :

1. Outil interne : cliquer "Publier" pour un bien quelconque
2. La fonction renvoie `status: "needs_login"` + `relogin_url`
3. L'outil interne **ouvre ce lien dans un onglet** (cf. snippet plus haut)
4. La page demande email + password du compte Facebook bot
5. Si 2FA : un champ pour le code apparaît
6. Après succès : la page affiche ✅ et le job repart automatiquement

**À noter** :
- L'email et le password ne sont **jamais stockés** : ils ne servent qu'à
  remplir le formulaire FB côté serveur, puis sont jetés.
- L'URL `/relogin` contient un `token` (auto-généré par Render). Il agit
  comme une protection basique pour qu'un randonneur tombant sur l'URL ne
  voit pas le formulaire. À partager avec l'équipe interne uniquement.

---

## 5. Cycle de vie d'un job

```
[queued] ──▶ [running] ──┬──▶ [completed]    posts: [{group_id, post_url, status:success}]
                         ├──▶ [partial]      certains groupes OK, d'autres en échec
                         ├──▶ [failed]       tous les posts ont échoué
                         └──▶ [needs_login]  session FB morte → en attente de /relogin
                              │
                              └─ après reconnexion réussie : retour à [queued]
```

L'outil interne poll `GET /status` toutes les 3–5 secondes jusqu'à voir un
statut terminal. Le `result.posts[]` contient les URLs des posts publiés.

---

## 6. Test mode → Prod

Pendant le test (`TEST_MODE=true` côté Render) :
- Seul ton groupe avec `is_test=true` reçoit des publications
- Tout le reste fonctionne normalement (deletion, retry, etc.)

Pour passer en prod :
1. Insérer les vrais groupes : `INSERT INTO fb_groups (name, url, is_test) VALUES ('...', '...', false)`
2. Render → Environment → `TEST_MODE=false`
3. Save & redeploy

---

## 7. Comportement en cas d'échec

| Échec                              | Comportement                                                 |
|------------------------------------|--------------------------------------------------------------|
| Cookies expirés au début du job    | Job marqué `needs_login`, Slack envoyé, frontend reçoit le lien `/relogin` |
| Cookies expirés en cours de job    | Idem — le job est interrompu, les posts déjà publiés sont conservés |
| Composer introuvable sur un groupe | 2 retries, puis groupe sauté ; les autres groupes continuent |
| Upload image bloqué                | Attente jusqu'à 90 s ; sinon groupe sauté                    |
| Suppression échouée                | Logué + marqué `failed` sur la ligne, on continue            |
| Worker crashé en plein job         | Au redémarrage, le job reste en `running`. Réutiliser le SQL plus bas pour libérer. |

```sql
-- Reaper : libère les jobs bloqués en running depuis > 15 min
UPDATE fb_posting_jobs
SET    status = 'queued', started_at = NULL
WHERE  status = 'running'
  AND  started_at < now() - interval '15 minutes';
```

---

## 8. Notes de sécurité

- Le mot de passe FB transite par HTTPS jusqu'au worker, puis sert
  uniquement à remplir le formulaire de login côté serveur. Il n'est
  jamais écrit en DB, jamais loggé.
- L'URL `/relogin` est protégée par `RELOGIN_TOKEN`. Considère-le comme
  un secret à partager avec l'équipe.
- Le bucket `fb-sessions` est **private** (RLS active, pas de policy). Seul
  le `service_role` y accède — donc seul ton worker peut lire / écrire
  les cookies.
- Une seule personne à la fois doit faire les actions sur le compte FB.
  Si l'équipe est multiple, prévenir avant un changement de mot de passe.

---

## 9. Dev local (Mac)

Pour itérer sans redéployer :

```bash
cd worker
cp .env.example .env
# remplir SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
# laisser PUBLIC_BASE_URL=http://localhost:8080
# laisser HEADLESS=false pour voir Chromium
npm install
npm run dev
```

Puis dans un autre terminal :

```bash
# tester /healthz
curl http://localhost:8080/healthz

# simuler un push de l'Edge Function (insère un job en DB par ailleurs)
curl -X POST http://localhost:8080/trigger \
  -H 'content-type: application/json' \
  -H "x-worker-key: $WORKER_SECRET" \
  -d '{"job_id":"<uuid-d-un-job-queued>"}'

# tester /relogin
open "http://localhost:8080/relogin?token=$RELOGIN_TOKEN"
```
