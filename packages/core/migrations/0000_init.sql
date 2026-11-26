CREATE TABLE "ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text,
	"model" text NOT NULL,
	"api_key_enc" text,
	"temperature" real DEFAULT 0.4 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text,
	"user_id" text,
	"feature" text NOT NULL,
	"provider_kind" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_hourly" (
	"guild_id" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"joins" integer DEFAULT 0 NOT NULL,
	"leaves" integer DEFAULT 0 NOT NULL,
	"active_users" integer DEFAULT 0 NOT NULL,
	"voice_minutes" integer DEFAULT 0 NOT NULL,
	"commands" integer DEFAULT 0 NOT NULL,
	"member_count" integer,
	CONSTRAINT "analytics_hourly_guild_id_hour_pk" PRIMARY KEY("guild_id","hour")
);
--> statement-breakpoint
CREATE TABLE "appeals" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"case_id" integer,
	"user_id" text NOT NULL,
	"user_tag" text,
	"content" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewer_id" text,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "architect_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"title" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blueprint" jsonb,
	"analysis" jsonb,
	"plan" jsonb,
	"status" text DEFAULT 'drafting' NOT NULL,
	"backup_id" uuid,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"automation_id" uuid NOT NULL,
	"guild_id" text NOT NULL,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"definition" jsonb NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blueprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text,
	"name" text NOT NULL,
	"description" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blueprint" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"actor_id" text,
	"source" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_activity" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "channel_activity_guild_id_channel_id_day_pk" PRIMARY KEY("guild_id","channel_id","day")
);
--> statement-breakpoint
CREATE TABLE "config_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_access" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"level" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"user" jsonb NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone NOT NULL,
	"guild_cache" jsonb,
	"guild_cache_at" timestamp with time zone,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economy_accounts" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"lifetime_earned" bigint DEFAULT 0 NOT NULL,
	"last_daily_at" timestamp with time zone,
	"streak" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "economy_accounts_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "giveaways" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"prize" text NOT NULL,
	"description" text,
	"winner_count" integer DEFAULT 1 NOT NULL,
	"host_id" text NOT NULL,
	"required_role_id" text,
	"min_level" integer,
	"entrants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"winner_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_state" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"raid_mode" boolean DEFAULT false NOT NULL,
	"raid_mode_until" timestamp with time zone,
	"lockdown" boolean DEFAULT false NOT NULL,
	"restore_data" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"owner_id" text NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_levels" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"voice_minutes" integer DEFAULT 0 NOT NULL,
	"last_xp_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_levels_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "mod_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"case_number" integer NOT NULL,
	"type" text NOT NULL,
	"target_id" text NOT NULL,
	"target_tag" text,
	"moderator_id" text NOT NULL,
	"reason" text,
	"duration_ms" bigint,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"automated" boolean DEFAULT false NOT NULL,
	"explanation" jsonb,
	"log_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"votes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"multiple" boolean DEFAULT false NOT NULL,
	"anonymous" boolean DEFAULT true NOT NULL,
	"creator_id" text NOT NULL,
	"ends_at" timestamp with time zone,
	"ended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_menus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"channel_id" text,
	"message_id" text,
	"style" text NOT NULL,
	"mode" text DEFAULT 'toggle' NOT NULL,
	"embed" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"max_selections" integer,
	"required_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"kind" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"user_id" text,
	"summary" text NOT NULL,
	"details" jsonb,
	"action_taken" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_heartbeats" (
	"service" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"details" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_panels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"channel_id" text,
	"message_id" text,
	"style" text DEFAULT 'buttons' NOT NULL,
	"embed" jsonb NOT NULL,
	"categories" jsonb NOT NULL,
	"staff_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parent_category_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_transcripts" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"html" text NOT NULL,
	"message_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"panel_id" uuid,
	"category_id" text,
	"category_label" text,
	"number" integer NOT NULL,
	"channel_id" text,
	"opener_id" text NOT NULL,
	"opener_tag" text,
	"claimed_by_id" text,
	"assignee_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"subject" text,
	"answers" jsonb,
	"closed_by_id" text,
	"close_reason" text,
	"first_response_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_achievements" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_achievements_guild_id_user_id_key_pk" PRIMARY KEY("guild_id","user_id","key")
);
--> statement-breakpoint
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_case_id_mod_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."mod_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architect_sessions" ADD CONSTRAINT "architect_sessions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_backups" ADD CONSTRAINT "config_backups_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_commands" ADD CONSTRAINT "custom_commands_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_access" ADD CONSTRAINT "dashboard_access_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD CONSTRAINT "guild_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_menus" ADD CONSTRAINT "role_menus_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_panels" ADD CONSTRAINT "ticket_panels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_transcripts" ADD CONSTRAINT "ticket_transcripts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_panel_id_ticket_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."ticket_panels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_guild" ON "ai_usage" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_user" ON "ai_usage" USING btree ("guild_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "appeals_guild" ON "appeals" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "architect_sessions_guild" ON "architect_sessions" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_guild" ON "automation_runs" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "automations_guild" ON "automations" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "change_log_guild" ON "change_log" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "config_backups_guild" ON "config_backups" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_commands_name" ON "custom_commands" USING btree ("guild_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_access_unique" ON "dashboard_access" USING btree ("guild_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "dashboard_sessions_user" ON "dashboard_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "economy_rank" ON "economy_accounts" USING btree ("guild_id","balance");--> statement-breakpoint
CREATE INDEX "giveaways_active" ON "giveaways" USING btree ("ended","ends_at");--> statement-breakpoint
CREATE INDEX "member_levels_rank" ON "member_levels" USING btree ("guild_id","xp");--> statement-breakpoint
CREATE UNIQUE INDEX "mod_cases_number" ON "mod_cases" USING btree ("guild_id","case_number");--> statement-breakpoint
CREATE INDEX "mod_cases_target" ON "mod_cases" USING btree ("guild_id","target_id");--> statement-breakpoint
CREATE INDEX "mod_cases_expiry" ON "mod_cases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "polls_active" ON "polls" USING btree ("ended","ends_at");--> statement-breakpoint
CREATE INDEX "role_menus_message" ON "role_menus" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_due" ON "scheduled_jobs" USING btree ("done","run_at");--> statement-breakpoint
CREATE INDEX "security_events_guild" ON "security_events" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_number" ON "tickets" USING btree ("guild_id","number");--> statement-breakpoint
CREATE INDEX "tickets_status" ON "tickets" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "tickets_channel" ON "tickets" USING btree ("channel_id");