/**
 * @file Preflight.gs (SDC library)
 * Common pre-execution checks for any flow that serializes config and
 * hands it to Workato.
 *
 * Public:
 *   Preflight.run(ss, config, options) → { customerSheet, integrationAccountEmail,
 *                                           [clientName, analystEmail,
 *                                            targetVms, separateWorkspace] }
 *
 * Throw-on-failure contract: every check raises a user-facing Error on
 * the first failure. Orchestrators wrap the call in a single try/catch
 * and own UI/logging.
 *
 * Checks (in order):
 *   1. Schema sanity — already enforced by Config.build; preflight does
 *      not re-check.
 *   2. All CONNECTOR_SHEETS present in the workbook.
 *   3. The customer sheet (per config.sheets.customer) is present.
 *   4. The supplied webhook URL is non-empty.
 *   5. config.sharing.integrationAccountEmail is present and email-shaped.
 *   6. (Optional) Customer name and analyst email populated in 1_customer.
 */

var Preflight = {};

/**
 * @param {Spreadsheet} ss
 * @param {Object}      config
 * @param {Object}      options
 * @param {string}      options.webhookUrl                  - The URL to validate (caller resolves
 *                                                            from config.webhook.* and passes in).
 * @param {string}      options.webhookLabel                - The _developer_settings key for error
 *                                                            messages (e.g. 'fileExportUrl').
 * @param {boolean}     [options.requireCustomerData=false] - When true, also pull and validate
 *                                                            customer fields from 1_customer.
 * @returns {Object} { customerSheet, integrationAccountEmail,
 *                     [clientName, analystEmail, targetVms, separateWorkspace] }
 * @throws  Error with a user-facing message on any check failure.
 */
Preflight.run = function(ss, config, options) {
  if (!ss)      throw new Error('Preflight.run: ss is required.');
  if (!config)  throw new Error('Preflight.run: config is required.');
  if (!options) throw new Error('Preflight.run: options is required.');

  // 1. All connector sheets present
  var missing = [];
  CONNECTOR_SHEETS_ORDER.forEach(function(name) {
    if (!ss.getSheetByName(name)) missing.push(name);
  });
  if (missing.length > 0) {
    throw new Error(
      'Missing required sheets: ' + missing.join(', ') + '. ' +
      'These sheets are part of the workbook schema (v' + config.schemaVersion + ') ' +
      'and must be present for the SDC platform to read the configuration.'
    );
  }

  // 2. Customer sheet present (defensive — already covered by check 1, but the
  //    error message here is more specific to the customer-data flow.)
  var customerSheet = ss.getSheetByName(config.sheets.customer);
  if (!customerSheet) {
    throw new Error(
      'Sheet "' + config.sheets.customer + '" not found. ' +
      'This is the workbook\'s customer-information tab; check that it has not been ' +
      'renamed and that _developer_settings → sheets.customer matches.'
    );
  }

  // 3. Webhook URL configured
  if (!options.webhookUrl) {
    throw new Error(
      'Webhook URL not configured. ' +
      'Check _developer_settings → webhook.' + options.webhookLabel + '.'
    );
  }

  // 4. Workato OAuth account email present and well-formed
  var integrationAccountEmail = config.sharing.integrationAccountEmail;
  if (!integrationAccountEmail || !Util.isValidEmailShape(integrationAccountEmail)) {
    throw new Error(
      'Workato OAuth account email is missing or malformed. ' +
      'Check _developer_settings → sharing.integrationAccountEmail. ' +
      'Workato cannot read the config file without this share.'
    );
  }

  // 5. Optional: customer data fields (provision path only)
  var customerData = {};
  if (options.requireCustomerData) {
    customerData = {
      clientName:        Util.findValueRightOfLabel(customerSheet, Labels.customerName),
      analystEmail:      Util.findValueRightOfLabel(customerSheet, Labels.analystEmail),
      targetVms:         Util.findValueRightOfLabel(customerSheet, Labels.targetVMS),
      separateWorkspace: Util.findValueRightOfLabel(customerSheet, Labels.separateWorkspace)
    };

    if (!customerData.clientName || !customerData.analystEmail) {
      throw new Error(
        'Customer name and analyst email are required in the ' +
        config.sheets.customer + ' tab. ' +
        'Both fields must be filled in before the configuration can be sent to Workato.'
      );
    }
  }

  return Object.assign({
    customerSheet:           customerSheet,
    integrationAccountEmail: integrationAccountEmail
  }, customerData);
};
