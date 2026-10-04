CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"user_name" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_check" CHECK ("audit_log"."action" in ('create', 'update', 'delete', 'activate', 'deactivate', 'resolve', 'grant_access', 'resend_access')),
	CONSTRAINT "audit_log_entity_type_check" CHECK ("audit_log"."entity_type" in ('product', 'category', 'staff', 'transaction', 'loan_request', 'settings'))
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "loan_request_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"requested_quantity" integer NOT NULL,
	"offered_quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"reference_no" text,
	"staff_id" text NOT NULL,
	"staff_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"admin_message" text,
	"from_date" date NOT NULL,
	"to_date" date,
	"original_from_date" date NOT NULL,
	"original_to_date" date,
	"fulfilled_txn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_requests_reference_no_unique" UNIQUE("reference_no"),
	CONSTRAINT "loan_requests_status_check" CHECK ("loan_requests"."status" in ('pending', 'countered', 'accepted', 'declined', 'expired', 'withdrawn', 'fulfilled', 'no_show'))
);
--> statement-breakpoint
CREATE TABLE "product_barcodes" (
	"barcode" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text,
	"category_name" text,
	"name" text NOT NULL,
	"description" text,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"reorder_threshold" integer DEFAULT 0 NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"lend_from" date,
	"lend_to" date,
	"lending_interval" text,
	"images" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_quantity_on_hand_check" CHECK ("products"."quantity_on_hand" >= 0),
	CONSTRAINT "products_lending_interval_check" CHECK ("products"."lending_interval" is null or "products"."lending_interval" in ('week_1', 'week_2', 'week_3', 'month_1', 'indefinite'))
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"uid" text PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_role_check" CHECK ("profiles"."role" in ('admin', 'staff'))
);
--> statement-breakpoint
CREATE TABLE "return_waivers" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"staff_id" text,
	"staff_name" text,
	"quantity" integer NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by_uid" text,
	"resolved_by_name" text,
	CONSTRAINT "return_waivers_quantity_check" CHECK ("return_waivers"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "sent_notifications" (
	"key" text PRIMARY KEY NOT NULL,
	"toggle" text NOT NULL,
	"entity_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"surname" text NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"department" text,
	"card_uid" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"uid" text,
	"is_admin_account" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_card_uid_unique" UNIQUE("card_uid"),
	CONSTRAINT "staff_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
CREATE TABLE "transaction_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"barcode" text,
	"issued_barcode" text,
	"quantity" integer NOT NULL,
	"unit_cost" numeric DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_lines_quantity_check" CHECK ("transaction_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_type" text NOT NULL,
	"reference_no" text NOT NULL,
	"staff_id" text,
	"staff_name" text,
	"user_id" text,
	"operator_name" text,
	"notes" text,
	"return_date" date,
	"linked_txn_id" text,
	"manual_override" boolean,
	"lend_from" date,
	"lend_to" date,
	"linked_request_id" text,
	"linked_request_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_reference_no_unique" UNIQUE("reference_no"),
	CONSTRAINT "transactions_type_check" CHECK ("transactions"."transaction_type" in ('IN', 'OUT', 'RETURN', 'ADJUST'))
);
--> statement-breakpoint
ALTER TABLE "loan_request_lines" ADD CONSTRAINT "loan_request_lines_request_id_loan_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."loan_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_request_lines" ADD CONSTRAINT "loan_request_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_requests" ADD CONSTRAINT "loan_requests_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_requests" ADD CONSTRAINT "loan_requests_fulfilled_txn_id_transactions_id_fk" FOREIGN KEY ("fulfilled_txn_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_waivers" ADD CONSTRAINT "return_waivers_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_waivers" ADD CONSTRAINT "return_waivers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_waivers" ADD CONSTRAINT "return_waivers_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_lines" ADD CONSTRAINT "transaction_lines_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_lines" ADD CONSTRAINT "transaction_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_linked_txn_id_transactions_id_fk" FOREIGN KEY ("linked_txn_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_linked_request_id_loan_requests_id_fk" FOREIGN KEY ("linked_request_id") REFERENCES "public"."loan_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "loan_request_lines_request_id_idx" ON "loan_request_lines" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "loan_requests_staff_status_idx" ON "loan_requests" USING btree ("staff_id","status");--> statement-breakpoint
CREATE INDEX "loan_requests_status_idx" ON "loan_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "product_barcodes_product_id_idx" ON "product_barcodes" USING btree ("product_id","position");--> statement-breakpoint
CREATE INDEX "products_category_id_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "return_waivers_transaction_id_idx" ON "return_waivers" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_email_lower_uq" ON "staff" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "transaction_lines_transaction_id_idx" ON "transaction_lines" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_lines_product_id_idx" ON "transaction_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "transactions_staff_created_idx" ON "transactions" USING btree ("staff_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_type_created_idx" ON "transactions" USING btree ("transaction_type","created_at");