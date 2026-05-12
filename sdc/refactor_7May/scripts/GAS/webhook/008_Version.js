/**
 * @file Version.gs (SDC library)
 * Version constants for the SDC library. Single source of truth for all three version axes:
 *
 *   LIBRARY â€” semver of the library code itself. Bumps on any release.
 *   PAYLOAD â€” webhook contract version. Bumps when payload SHAPE changes
 *             (renames, type changes). Stamped onto every webhook by
 *             Webhook.call. R-1 reads this to handshake.
 *   SCHEMA  â€” workbook schema version the library expects. Bumps when
 *             the structural shape of the workbook changes (sheets,
 *             columns, label strings). Migrations.run reconciles
 *             workbooks to this version.
 *
 * These three axes version independently. A library bump is not a
 * payload bump is not a schema bump.
 *
 * Consumer access: SDC.Version.LIBRARY, SDC.Version.PAYLOAD, SDC.Version.SCHEMA
 * Library-internal access: SDC_LIBRARY_VERSION, SDC_PAYLOAD_VERSION, SDC_SCHEMA_VERSION
 *
 * Both forms point at the same value; the bare aliases exist because
 * library-internal code reads them in lots of places and SDC.Version.X
 * is awkward when you're already inside the library.
 *
 * --- Payload version history -----------------------------------------
 *   1.0 â€” Initial release.
 *   2.0 â€” Provision payload: renamed config_json_file_id to
 *         drive_id_config_json; added is_initial (boolean, menu-derived).
 *         Validate and portal-invite payloads unchanged.
 *   3.0 â€” Provision payload: added output_drive_folder_id, reminder_days_1,
 *         reminder_days_2, reminder_days_3 (all required, all sourced from
 *         1_customer via Preflight). Validate and portal-invite payloads
 *         unchanged.
 */

var Version = Object.freeze({
  LIBRARY: '1.0.0',
  PAYLOAD: '3.0',
  SCHEMA:  '1.0'
});

// Library-internal aliases â€” used by Config, Drive, Webhook, Migrations.
var SDC_LIBRARY_VERSION = Version.LIBRARY;
var SDC_PAYLOAD_VERSION = Version.PAYLOAD;
var SDC_SCHEMA_VERSION  = Version.SCHEMA;
