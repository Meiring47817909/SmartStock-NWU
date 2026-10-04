-- Existing rows (if any) get 0; the default is dropped again so every new line must say where it sits in its transaction.
ALTER TABLE "transaction_lines" ADD COLUMN "line_no" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_lines" ALTER COLUMN "line_no" DROP DEFAULT;
