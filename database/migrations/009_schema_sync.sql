-- 009: bring a fresh install up to the current schema.
-- Before this, columns on users (language, theme, avatar, ...) were only added by hand, so the
-- backend startup migration aborted on an empty database and ~30 tables were never created.
-- Generated from the live schema on 2026-11-23 (pg_dump --schema-only). Runs only on an empty database (initdb).

ALTER TABLE public.conversation_attachments ADD COLUMN IF NOT EXISTS sent_at timestamp with time zone;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS accent_color character varying(7) DEFAULT '#CC785C'::character varying NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS default_model character varying(64);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS language character varying(5) DEFAULT 'en'::character varying NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pending_totp_secret text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS preferences jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS theme character varying(30) DEFAULT 'dark'::character varying NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS theme_mode character varying(16) DEFAULT 'system'::character varying NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS totp_enabled boolean DEFAULT false NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS totp_secret text;

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_delegations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_delegations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    agent_id uuid,
    parent_conversation_id uuid,
    conversation_id uuid NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    result_summary text,
    prompt text NOT NULL,
    parent_message_id uuid,
    privileged boolean DEFAULT false NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    reported_at timestamp with time zone,
    CONSTRAINT agent_delegations_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text, 'interrupted'::text])))
);


--
-- Name: agent_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    agent_id uuid,
    kind text NOT NULL,
    title text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    evidence text DEFAULT ''::text NOT NULL,
    before text,
    after text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    delegation_id uuid,
    CONSTRAINT agent_proposals_kind_check CHECK ((kind = ANY (ARRAY['prompt'::text, 'model'::text, 'description'::text, 'skill'::text, 'other'::text]))),
    CONSTRAINT agent_proposals_status_check CHECK ((status = ANY (ARRAY['open'::text, 'applied'::text, 'rejected'::text, 'reverted'::text])))
);


--
-- Name: agent_training_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_training_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id uuid NOT NULL,
    before jsonb,
    after jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text NOT NULL,
    prompt text NOT NULL,
    model text DEFAULT 'inherit'::text NOT NULL,
    avatar text,
    color character varying(7) DEFAULT '#6366f1'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    knowledge text,
    trained_at timestamp with time zone,
    trained_conversations integer DEFAULT 0 NOT NULL
);


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value_enc text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: context_sizes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.context_sizes (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    conversation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claude_md_tokens integer NOT NULL,
    memory_tokens integer DEFAULT 0 NOT NULL,
    lessons_tokens integer DEFAULT 0 NOT NULL,
    global_md_tokens integer DEFAULT 0 NOT NULL,
    skills_tokens integer DEFAULT 0 NOT NULL,
    skills_count integer DEFAULT 0 NOT NULL,
    agents_tokens integer DEFAULT 0 NOT NULL,
    total_tokens integer NOT NULL,
    budget integer NOT NULL,
    trimmed text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: context_sizes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.context_sizes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: context_sizes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.context_sizes_id_seq OWNED BY public.context_sizes.id;


--
-- Name: device_enroll_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_enroll_codes (
    code_hash text NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: device_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_favorites (
    user_id uuid NOT NULL,
    device_id uuid NOT NULL
);


--
-- Name: device_global_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_global_settings (
    key text NOT NULL,
    value text DEFAULT ''::text NOT NULL
);


--
-- Name: device_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    user_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: device_scripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_scripts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    os text DEFAULT 'windows'::text NOT NULL,
    shell text DEFAULT ''::text NOT NULL,
    runas text DEFAULT 'system'::text NOT NULL,
    timeout_sec integer DEFAULT 600 NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: device_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_settings (
    user_id uuid NOT NULL,
    require_totp boolean DEFAULT true NOT NULL
);


--
-- Name: device_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    user_id uuid NOT NULL,
    label text NOT NULL,
    tool text,
    command text NOT NULL,
    shell text DEFAULT ''::text NOT NULL,
    timeout_sec integer DEFAULT 1800 NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    run_at timestamp with time zone,
    runas text
);


--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    hostname text,
    os text,
    os_name text,
    arch text,
    agent_version text,
    token_hash text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    inventory jsonb,
    inventory_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    last_ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    display_name text,
    org text,
    location text,
    assigned_user text,
    role text,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    maintenance_until timestamp with time zone,
    maintenance_reason text,
    alerts_ack jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: learn_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.learn_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    run_id uuid,
    conversation_id uuid,
    kind text NOT NULL,
    action text NOT NULL,
    target_id uuid,
    before jsonb,
    after jsonb,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reverted_at timestamp with time zone
);


--
-- Name: learn_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.learn_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    conversation_id uuid,
    kind text NOT NULL,
    status text DEFAULT 'bezig'::text NOT NULL,
    model text,
    input_chars integer DEFAULT 0 NOT NULL,
    saved integer DEFAULT 0 NOT NULL,
    skipped integer DEFAULT 0 NOT NULL,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: learn_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.learn_state (
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    learned_until timestamp with time zone NOT NULL,
    runs integer DEFAULT 0 NOT NULL,
    last_status text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: message_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    content text NOT NULL,
    sort double precision DEFAULT EXTRACT(epoch FROM clock_timestamp()) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attachment_ids jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: messenger_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messenger_settings (
    user_id uuid NOT NULL,
    claude_telegram boolean DEFAULT true NOT NULL,
    claude_whatsapp boolean DEFAULT true NOT NULL,
    relay_telegram boolean DEFAULT true NOT NULL,
    relay_whatsapp boolean DEFAULT true NOT NULL,
    mirror_telegram boolean DEFAULT false NOT NULL,
    mirror_whatsapp boolean DEFAULT false NOT NULL,
    sync_active boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    contacts_whatsapp boolean DEFAULT false NOT NULL,
    recipients_per_hour integer DEFAULT 20 NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(120) NOT NULL,
    color character varying(16) DEFAULT 'terracotta'::character varying NOT NULL,
    icon character varying(32) DEFAULT 'folder'::character varying NOT NULL,
    instructions text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduled_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    prompt text NOT NULL,
    agent_id uuid,
    cron text,
    schedule_text text DEFAULT ''::text NOT NULL,
    run_at timestamp with time zone,
    timezone text DEFAULT 'Europe/Amsterdam'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    autonomous boolean DEFAULT false NOT NULL,
    conversation_id uuid,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    last_status text,
    last_summary text,
    source_pattern text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduled_tasks_check CHECK (((cron IS NOT NULL) OR (run_at IS NOT NULL)))
);


--
-- Name: shared_lessons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_lessons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    topic text NOT NULL,
    lesson text NOT NULL,
    user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: skill_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skill_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    pattern_id uuid,
    name text NOT NULL,
    description text NOT NULL,
    body text NOT NULL,
    script_name text,
    script_lang text,
    script_content text,
    reason text DEFAULT ''::text NOT NULL,
    conversation_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    installed_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone
);


--
-- Name: system_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_config (
    key character varying(100) NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: task_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_patterns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    key text NOT NULL,
    summary text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    conversation_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    proposed_at_count integer DEFAULT 0 NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    automate_dismissed_at timestamp with time zone
);


--
-- Name: task_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    user_id uuid NOT NULL,
    conversation_id uuid,
    kind text DEFAULT 'gepland'::text NOT NULL,
    status text DEFAULT 'bezig'::text NOT NULL,
    message_text text,
    assistant_msg_id uuid,
    summary text,
    has_proposal boolean DEFAULT false NOT NULL,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: telegram_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_links (
    user_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    bot_token_enc text,
    bot_username text,
    chat_id bigint,
    chat_name text,
    active_conversation_id uuid,
    status text,
    status_message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    update_offset bigint DEFAULT 0 NOT NULL,
    pair_code text,
    pair_code_expires timestamp with time zone,
    pair_attempts integer DEFAULT 0 NOT NULL,
    bot_name text,
    bot_avatar text
);


--
-- Name: user_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    topic text NOT NULL,
    content text NOT NULL,
    tags text DEFAULT ''::text NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    use_count integer DEFAULT 0 NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tsv tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('dutch'::regconfig, ((topic || ' '::text) || tags)), 'A'::"char") || setweight(to_tsvector('dutch'::regconfig, content), 'B'::"char"))) STORED,
    archived_at timestamp with time zone,
    archive_reason text,
    merged_into uuid
);


--
-- Name: whatsapp_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_contacts (
    user_id uuid NOT NULL,
    jid text NOT NULL,
    lid text,
    phone text,
    name text,
    notify text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_links (
    user_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    phone_jid text,
    phone_lid text,
    push_name text,
    active_conversation_id uuid,
    status text,
    status_message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: context_sizes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_sizes ALTER COLUMN id SET DEFAULT nextval('public.context_sizes_id_seq'::regclass);


--
-- Name: agent_delegations agent_delegations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_pkey PRIMARY KEY (id);


--
-- Name: agent_proposals agent_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_pkey PRIMARY KEY (id);


--
-- Name: agent_training_log agent_training_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_training_log
    ADD CONSTRAINT agent_training_log_pkey PRIMARY KEY (id);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);


--
-- Name: context_sizes context_sizes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_sizes
    ADD CONSTRAINT context_sizes_pkey PRIMARY KEY (id);


--
-- Name: device_enroll_codes device_enroll_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_enroll_codes
    ADD CONSTRAINT device_enroll_codes_pkey PRIMARY KEY (code_hash);


--
-- Name: device_favorites device_favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_favorites
    ADD CONSTRAINT device_favorites_pkey PRIMARY KEY (user_id, device_id);


--
-- Name: device_global_settings device_global_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_global_settings
    ADD CONSTRAINT device_global_settings_pkey PRIMARY KEY (key);


--
-- Name: device_notes device_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_notes
    ADD CONSTRAINT device_notes_pkey PRIMARY KEY (id);


--
-- Name: device_scripts device_scripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_scripts
    ADD CONSTRAINT device_scripts_pkey PRIMARY KEY (id);


--
-- Name: device_settings device_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_settings
    ADD CONSTRAINT device_settings_pkey PRIMARY KEY (user_id);


--
-- Name: device_tasks device_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tasks
    ADD CONSTRAINT device_tasks_pkey PRIMARY KEY (id);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: devices devices_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_token_hash_key UNIQUE (token_hash);


--
-- Name: learn_log learn_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learn_log
    ADD CONSTRAINT learn_log_pkey PRIMARY KEY (id);


--
-- Name: learn_runs learn_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learn_runs
    ADD CONSTRAINT learn_runs_pkey PRIMARY KEY (id);


--
-- Name: learn_state learn_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learn_state
    ADD CONSTRAINT learn_state_pkey PRIMARY KEY (conversation_id);


--
-- Name: message_queue message_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_queue
    ADD CONSTRAINT message_queue_pkey PRIMARY KEY (id);


--
-- Name: messenger_settings messenger_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messenger_settings
    ADD CONSTRAINT messenger_settings_pkey PRIMARY KEY (user_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: scheduled_tasks scheduled_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_pkey PRIMARY KEY (id);


--
-- Name: shared_lessons shared_lessons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_lessons
    ADD CONSTRAINT shared_lessons_pkey PRIMARY KEY (id);


--
-- Name: skill_proposals skill_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_proposals
    ADD CONSTRAINT skill_proposals_pkey PRIMARY KEY (id);


--
-- Name: system_config system_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (key);


--
-- Name: task_patterns task_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_patterns
    ADD CONSTRAINT task_patterns_pkey PRIMARY KEY (id);


--
-- Name: task_patterns task_patterns_user_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_patterns
    ADD CONSTRAINT task_patterns_user_id_key_key UNIQUE (user_id, key);


--
-- Name: task_runs task_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_runs
    ADD CONSTRAINT task_runs_pkey PRIMARY KEY (id);


--
-- Name: telegram_links telegram_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_links
    ADD CONSTRAINT telegram_links_pkey PRIMARY KEY (user_id);


--
-- Name: user_memories user_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_memories
    ADD CONSTRAINT user_memories_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_contacts whatsapp_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contacts
    ADD CONSTRAINT whatsapp_contacts_pkey PRIMARY KEY (user_id, jid);


--
-- Name: whatsapp_links whatsapp_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_links
    ADD CONSTRAINT whatsapp_links_pkey PRIMARY KEY (user_id);


--
-- Name: agent_delegations_conv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_delegations_conv_idx ON public.agent_delegations USING btree (conversation_id);


--
-- Name: agent_delegations_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_delegations_open_idx ON public.agent_delegations USING btree (user_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: agent_delegations_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_delegations_parent_idx ON public.agent_delegations USING btree (parent_conversation_id, created_at);


--
-- Name: agent_proposals_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_proposals_user_idx ON public.agent_proposals USING btree (user_id, status, created_at DESC);


--
-- Name: agent_training_log_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_training_log_agent_idx ON public.agent_training_log USING btree (agent_id, created_at DESC);


--
-- Name: agents_user_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agents_user_slug_idx ON public.agents USING btree (user_id, slug);


--
-- Name: context_sizes_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX context_sizes_user_idx ON public.context_sizes USING btree (user_id, created_at DESC);


--
-- Name: device_notes_dev_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_notes_dev_idx ON public.device_notes USING btree (device_id, created_at DESC);


--
-- Name: device_tasks_dev_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_tasks_dev_idx ON public.device_tasks USING btree (device_id, created_at DESC);


--
-- Name: devices_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_user_idx ON public.devices USING btree (user_id);


--
-- Name: idx_projects_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_user ON public.projects USING btree (user_id);


--
-- Name: idx_push_subs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subs_user ON public.push_subscriptions USING btree (user_id);


--
-- Name: idx_wa_contacts_lid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_contacts_lid ON public.whatsapp_contacts USING btree (user_id, lid);


--
-- Name: learn_log_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX learn_log_user_idx ON public.learn_log USING btree (user_id, created_at DESC);


--
-- Name: learn_runs_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX learn_runs_user_idx ON public.learn_runs USING btree (user_id, started_at DESC);


--
-- Name: message_queue_conv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_queue_conv_idx ON public.message_queue USING btree (conversation_id, sort);


--
-- Name: scheduled_tasks_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_tasks_due_idx ON public.scheduled_tasks USING btree (next_run_at) WHERE enabled;


--
-- Name: scheduled_tasks_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_tasks_user_idx ON public.scheduled_tasks USING btree (user_id, created_at);


--
-- Name: shared_lessons_text_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shared_lessons_text_idx ON public.shared_lessons USING btree (lower(lesson));


--
-- Name: skill_proposals_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX skill_proposals_user_idx ON public.skill_proposals USING btree (user_id, status);


--
-- Name: task_runs_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_runs_open_idx ON public.task_runs USING btree (conversation_id) WHERE (status = ANY (ARRAY['bezig'::text, 'wachtrij'::text]));


--
-- Name: task_runs_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_runs_task_idx ON public.task_runs USING btree (task_id, started_at DESC);


--
-- Name: user_memories_text_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_memories_text_idx ON public.user_memories USING btree (user_id, md5(lower(content)));


--
-- Name: user_memories_tsv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_memories_tsv_idx ON public.user_memories USING gin (tsv);


--
-- Name: user_memories_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_memories_user_idx ON public.user_memories USING btree (user_id);


--
-- Name: agent_delegations agent_delegations_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;


--
-- Name: agent_delegations agent_delegations_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: agent_delegations agent_delegations_parent_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_parent_conversation_id_fkey FOREIGN KEY (parent_conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


--
-- Name: agent_delegations agent_delegations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_proposals agent_proposals_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;


--
-- Name: agent_proposals agent_proposals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_training_log agent_training_log_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_training_log
    ADD CONSTRAINT agent_training_log_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agents agents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: context_sizes context_sizes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_sizes
    ADD CONSTRAINT context_sizes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: device_enroll_codes device_enroll_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_enroll_codes
    ADD CONSTRAINT device_enroll_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: device_favorites device_favorites_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_favorites
    ADD CONSTRAINT device_favorites_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: device_favorites device_favorites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_favorites
    ADD CONSTRAINT device_favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: device_notes device_notes_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_notes
    ADD CONSTRAINT device_notes_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: device_notes device_notes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_notes
    ADD CONSTRAINT device_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: device_scripts device_scripts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_scripts
    ADD CONSTRAINT device_scripts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: device_settings device_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_settings
    ADD CONSTRAINT device_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: device_tasks device_tasks_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tasks
    ADD CONSTRAINT device_tasks_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: device_tasks device_tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tasks
    ADD CONSTRAINT device_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: devices devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: learn_log learn_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learn_log
    ADD CONSTRAINT learn_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: learn_runs learn_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learn_runs
    ADD CONSTRAINT learn_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: learn_state learn_state_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learn_state
    ADD CONSTRAINT learn_state_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: learn_state learn_state_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learn_state
    ADD CONSTRAINT learn_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: message_queue message_queue_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_queue
    ADD CONSTRAINT message_queue_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: message_queue message_queue_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_queue
    ADD CONSTRAINT message_queue_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: messenger_settings messenger_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messenger_settings
    ADD CONSTRAINT messenger_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: projects projects_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: scheduled_tasks scheduled_tasks_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;


--
-- Name: scheduled_tasks scheduled_tasks_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


--
-- Name: scheduled_tasks scheduled_tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: shared_lessons shared_lessons_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_lessons
    ADD CONSTRAINT shared_lessons_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: skill_proposals skill_proposals_pattern_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_proposals
    ADD CONSTRAINT skill_proposals_pattern_id_fkey FOREIGN KEY (pattern_id) REFERENCES public.task_patterns(id) ON DELETE SET NULL;


--
-- Name: skill_proposals skill_proposals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_proposals
    ADD CONSTRAINT skill_proposals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: task_patterns task_patterns_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_patterns
    ADD CONSTRAINT task_patterns_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: task_runs task_runs_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_runs
    ADD CONSTRAINT task_runs_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.scheduled_tasks(id) ON DELETE CASCADE;


--
-- Name: task_runs task_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_runs
    ADD CONSTRAINT task_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: telegram_links telegram_links_active_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_links
    ADD CONSTRAINT telegram_links_active_conversation_id_fkey FOREIGN KEY (active_conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


--
-- Name: telegram_links telegram_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_links
    ADD CONSTRAINT telegram_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_memories user_memories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_memories
    ADD CONSTRAINT user_memories_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_contacts whatsapp_contacts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contacts
    ADD CONSTRAINT whatsapp_contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_links whatsapp_links_active_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_links
    ADD CONSTRAINT whatsapp_links_active_conversation_id_fkey FOREIGN KEY (active_conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


--
-- Name: whatsapp_links whatsapp_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_links
    ADD CONSTRAINT whatsapp_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_conv_project ON public.conversations(project_id);
