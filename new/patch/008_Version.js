/**
 * @file 008_Version.gs (SDC library)
 * Version constants for the SDC library. Single source of truth for all three version axes:
 *
 *   LIBRARY - semver of the library code itself. Bumps on any release.
 *   PAYLOAD - webhook contract version. Bumps when payload SHAPE changes (renames, type changes). 
 *             Stamped onto every webhook by Webhook.call. R-1 reads this to handshake.
 *   SCHEMA  - workbook schema version the library expects. Bumps when the structural shape of the workbook changes (sheets,
 *             columns, label strings). Migrations.run reconciles workbooks to this version.
 *
 * These three axes version independently. A library bump is not a payload bump is not a schema bump.
 *
 * Consumer access:         SDC.Version.LIBRARY, SDC.Version.PAYLOAD, SDC.Version.SCHEMA
 * Library-internal access: SDC_LIBRARY_VERSION, SDC_PAYLOAD_VERSION, SDC_SCHEMA_VERSION
 *
 * Both forms point at the same value; the bare aliases exist because library-internal code reads them in lots of places and SDC.Version.X
 * is awkward when you're already inside the library.
 *
 * --- Payload version history -----------------------------------------
 *   1.0 - Initial release.
 *   2.0 - Provision payload: renamed config_json_file_id to drive_id_config_json; added is_initial (boolean, menu-derived).
 *         Validate and portal-invite payloads unchanged.
 *   3.0 - Provision payload: added output_drive_folder_id, reminder_days_1, reminder_days_2, reminder_days_3 
 *         (all required, all sourced from 1_customer via Preflight). Validate and portal-invite payloads unchanged.
 *   4.0 - Provision payload: added kickoff_email_body (required string: supplier-facing pre-invite email body,
 *         sourced from 1_customer via Preflight). Validate and portal-invite payloads unchanged.
 *   6.0 - Provision payload: added config_fingerprint (required string; SHA-256 hex of serialized config content, excluding
 *         _meta). Validate and portal-invite payloads unchanged.
 *   7.0 - Provision payload: added expected_date (required string, YYYY-MM-DD, date-only, rendered in the workbook's timezone;
 *         sourced from 1_customer via Preflight). Validate and portal-invite payloads unchanged.
 *   8.0 - Provision payload: removed reminder_days_1/2/3; added reminder_days (required, non-empty array of positive integers, analyst-entered
 *         order preserved; sourced from the single reminder-cadence field on 1_customer via Preflight/Customer). Validate and portal-invite
 *         payloads unchanged.
 *   9.0 - NOT RECORDED at release time. The shipped builder differs from the 8.0 description by: application_name, last_day_for_submission,
 *         has_seeded_data, seeded_data_drive_id, seeded_data_index_key, seeded_data_sheet_name, seeded_data_xlsx_file_id, spreadsheet_id.
 *         Confirm and reword before the next release.
 *  10.0 - Provision payload: added seeded_data_header_row and seeded_data_first_data_row (integers, 1-based Excel rows of the seed sheet's
 *         header and first data row; null when has_seeded_data is false; defaulted to 1 / header+1 by Preflight when the analyst leaves
 *         them blank). Config JSON gains a derived _customer block (see Drive.serializeConfig). Validate and portal-invite payloads unchanged.
 */

var Version = Object.freeze({
  LIBRARY: '1.7.0',
  PAYLOAD: '10.0',
  SCHEMA:  '1.6'
});

// Library-internal aliases - used by Config, Drive, Webhook, Migrations.
var SDC_LIBRARY_VERSION = Version.LIBRARY;
var SDC_PAYLOAD_VERSION = Version.PAYLOAD;
var SDC_SCHEMA_VERSION  = Version.SCHEMA;