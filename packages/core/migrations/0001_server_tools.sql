CREATE TABLE "feature_state" (
	"guild_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_state_guild_id_key_pk" PRIMARY KEY("guild_id","key")
);
--> statement-breakpoint
CREATE TABLE "member_invites" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"code" text,
	"inviter_id" text,
	"left" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_invites_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "starboard_posts" (
	"message_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"author_id" text NOT NULL,
	"starboard_message_id" text,
	"stars" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestion_votes" (
	"suggestion_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"value" integer NOT NULL,
	CONSTRAINT "suggestion_votes_suggestion_id_user_id_pk" PRIMARY KEY("suggestion_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"number" integer NOT NULL,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"thread_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"downvotes" integer DEFAULT 0 NOT NULL,
	"reviewer_id" text,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temp_voice_channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"panel_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suggestion_votes" ADD CONSTRAINT "suggestion_votes_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_invites_inviter" ON "member_invites" USING btree ("guild_id","inviter_id");--> statement-breakpoint
CREATE INDEX "starboard_guild" ON "starboard_posts" USING btree ("guild_id","stars");--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_number" ON "suggestions" USING btree ("guild_id","number");--> statement-breakpoint
CREATE INDEX "suggestions_message" ON "suggestions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "temp_voice_guild" ON "temp_voice_channels" USING btree ("guild_id");