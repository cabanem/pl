/**
 * @file 09_Core_Helpers.gs
 * @description Shared helpers used by feature runners.
 */

class AppHelpers {
  /** @returns {Object.<string,string>} id->name */
  static createLookupMap(items) {
    const arr = Array.isArray(items) ? items : [];
    return Object.fromEntries(arr.map(i => [String(i.id), i.name]));
  }

  /**
   * parseLogicRows rows: [recipeId, recipeName, step#, indent, provider, actionName, description, details]
   * @returns {string}
   */
  static logicDigestFromRows(logicRows, maxLines) {
    const lines = [];
    const slice = Array.isArray(logicRows) ? logicRows.slice(0, maxLines) : [];
    slice.forEach(r => {
      const stepNo = r[2];
      const indent = r[3] || "";
      const provider = r[4] || "";
      const action = r[5] || "";
      const desc = r[6] ? ` â€” ${String(r[6]).slice(0, 120)}` : "";
      lines.push(`${stepNo}. ${indent}${action} (${provider})${desc}`);
    });
    if (Array.isArray(logicRows) && logicRows.length > maxLines) {
      lines.push(`â€¦ (${logicRows.length - maxLines} more steps omitted)`);
    }
    return lines.join("\n");
  }

  static handleError(e) {
    let errorMsg = `Sync failed: ${e.message}`;
    if (String(e.message || "").includes("Unexpected token")) {
      errorMsg = "Auth Error: Check WORKATO_TOKEN and BASE_URL";
    }
    AppLog.notify(errorMsg, true);
    console.error(e && e.stack ? e.stack : e);
  }
}