# Fam points bot

Requires Node.js 18+ and the existing Slack and Supabase environment variables.

## Multiple activity submissions

Apply `innodfams/database/migrations/20260916_activity_occurrences.sql` and deploy the companion frontend before restarting this bot. See that repo's `database/ACTIVITY_ROLLOUT.md` for staging checks and historical-point reconciliation.

Leading bare Slack tags represent individual snipe targets. The sender earns each snipe award. For example, `@Aaron @Jeslyn + reach out cc with @Christy` creates two snipe activities for the sender and one reach-out coffee chat for the sender and Christy. Tags are scoped to their activity, not copied to all items. Repeated explicit snipe segments remain separate occurrences.

Use `+`, semicolons, newlines, or explicit category markers to separate activities. Ambiguous captions and unmatched tasks remain pending for manual correction. Plain names are not guessed from first-name substrings. Attachment count does not determine points, and the bot does not identify people from photos. Coffee-chat recipients remain editable to follow club rules.

Slack edits update pending submissions. Edits to reviewed submissions flag them without changing awarded points. Database transactions handle duplicate events and partial failures. A thread reply lists the extracted activities; no points are awarded until approval.

Run `npm test` for the caption and mocked message-handler regression tests. These tests do not access Slack or Supabase.
