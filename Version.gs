/**
 * @file Version.gs (SDC library)
 * Version constants for the SDC library. Single source of truth for
 * all three version axes:
 *
 *   LIBRARY — semver of the library code itself. Bumps on any release.
 *   PAYLOAD — webhook contract version. Bumps when payload SHAPE changes
 *             (renames, type changes). Stamped onto every webhook by
 *             Webhook.call. R-1 reads this to handshake.
 *   SCHEMA  — workbook schema version the library expects. Bumps when
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
 */

var Version = Object.freeze({
  LIBRARY: '1.0.0',
  PAYLOAD: '1.0',
  SCHEMA:  '1.0'
});

// Library-internal aliases — used by Config, Drive, Webhook, Migrations.
var SDC_LIBRARY_VERSION = Version.LIBRARY;
var SDC_PAYLOAD_VERSION = Version.PAYLOAD;
var SDC_SCHEMA_VERSION  = Version.SCHEMA;
