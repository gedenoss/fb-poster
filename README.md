# facebook group poster

le bot publie automatiquement une property dans des groupes facebook. l'equipe declenche la publication depuis l'outil interne

il tourne sur un serveur ec2 aws toujours allume et utilise supabase pour stocker les jobs les sessions et les logs

## le bot

quand quelqu'un clique sur publier une edge function supabase verifie que le bien a des chambres disponibles et qu'il n'a pas deja ete publie cette semaine, puis cree un job. le worker sur ec2 detecte le job, ouvre chromium en arriere-plan, verifie la session facebook, et poste dans chaque groupe correspondant a la ville du bien

entre chaque groupe le bot attend quelques minutes pour eviter les protections anti-spam de facebook. une fois termine il envoie un recap sur discord

## limites

une seule utilisation par semaine, du lundi au dimanche. si on publie le vendredi, la prochaine fois c'est le lundi suivant. la limite s'applique a tout du bot, pas juste a une propriete

un bien doit avoir au moins une chambre disponible sinon la demande est refusee

le nombre de groupes cibles depend de combien sont actifs dans la table fb_groups. on peut en ajouter ou retirer sans toucher au code. une limite par job est aussi configurable via MAX_GROUPS_PER_JOB dans le .env

## session facebook

le bot utilise un compte facebook dedie. les cookies sont stockes dans supabase storage et recharges a chaque job. si la session expire, l'admin est notifie (discord pour l instant) avec un lien pour se reconnecter

la meilleure facon de renouveler la session est d'extraire les cookies manuellement depuis le navigateur avec cookie-editor et de les uploader dans supabase storage. c'est plus fiable que le formulaire de connexion niveau ban/shadowban/longevite des cookies

## statuts d'un job

queued : en attente. running : en cours. completed : tout a reussi. partial : certains groupes ok, d'autres non. failed : rien n'a ete publie. needs_login : session expiree, reconnexion necessaire

## deploiement

    cd ~/app && git pull && pm2 restart fb-poster

    supabase functions deploy run-posting-job --no-verify-jwt

## variables d'environnement

    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    WORKER_SECRET
    PUBLIC_BASE_URL
    RELOGIN_TOKEN
    SESSION_BUCKET
    DISCORD_WEBHOOK_URL
    TEST_MODE
    GROUP_DELAY_MS
    MAX_GROUPS_PER_JOB

TEST_MODE=true limite le bot aux groupes marques is_test=true. mettre false pour la prod

UPDATE fb_posting_jobs
SET status = 'failed'
WHERE created_at >= '2026-05-26'
AND status IN ('queued', 'running',
'completed', 'partial');
met les job en fail pour esquiver la limit par semaine
