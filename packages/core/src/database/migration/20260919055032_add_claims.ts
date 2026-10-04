import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919055032_add_claims",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`claims\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`slug\` text NOT NULL,
          \`kind\` text DEFAULT 'implement' NOT NULL,
          \`holder_session\` text,
          \`holder_harness\` text,
          \`holder_name\` text,
          \`branch\` text,
          \`worktree\` text,
          \`provider_id\` text,
          \`model_id\` text,
          \`gate\` text,
          \`since\` integer NOT NULL,
          \`heartbeat\` integer NOT NULL,
          \`released_at\` integer,
          \`release_reason\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_claims_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`claims_project_slug_live_idx\` ON \`claims\` (\`project_id\`,\`slug\`) WHERE \`released_at\` IS NULL;`)
      yield* tx.run(`CREATE INDEX \`claims_holder_idx\` ON \`claims\` (\`holder_session\`);`)
      yield* tx.run(`CREATE INDEX \`claims_project_idx\` ON \`claims\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`claims_slug_idx\` ON \`claims\` (\`slug\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
