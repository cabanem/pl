// 1. TEMP_CONFIG: accept the number directly as a string
const TEMP_CONFIG = Object.freeze({
  workspaceId:    '500787859',  // set as string — was cleared for security but
                                // caused the resolution chain to silently fail.
                                // If you prefer not to hardcode this, call
                                // setDefaultWorkspaceRepairId('500787859') once
                                // and leave this as ''.
  debugEndpoints: false
});

// 2. resolveWorkspaceId_: explicitly coerce to string before the falsy check
// so numeric IDs passed directly don't fall through
function resolveWorkspaceId_(workspaceId, options) {
  const explicit = (workspaceId !== null && workspaceId !== undefined && String(workspaceId).trim() !== '')
    ? String(workspaceId).trim()
    : '';
  if (explicit) return explicit;

  const fromOptions = (options && options.defaultWorkspaceId !== null && options.defaultWorkspaceId !== undefined)
    ? String(options.defaultWorkspaceId).trim()
    : '';
  if (fromOptions) return fromOptions;

  const fromConfig = (TEMP_CONFIG && TEMP_CONFIG.workspaceId !== null && TEMP_CONFIG.workspaceId !== undefined)
    ? String(TEMP_CONFIG.workspaceId).trim()
    : '';
  if (fromConfig) return fromConfig;

  const fromScript = safeString_(
    PropertiesService.getScriptProperties().getProperty(WORKSPACE_REPAIR_DEFAULT_WORKSPACE_KEY_)
  );
  if (fromScript) return fromScript;

  throw new Error(
    'No workspaceId provided. Set TEMP_CONFIG.workspaceId, pass defaultWorkspaceId, ' +
    'or call setDefaultWorkspaceRepairId(...).'
  );
}

// 3. setDefaultWorkspaceRepairId: coerce number to string before the empty check
function setDefaultWorkspaceRepairId(workspaceId) {
  const value = (workspaceId !== null && workspaceId !== undefined)
    ? String(workspaceId).trim()
    : '';
  if (!value) throw new Error('workspaceId is required');
  PropertiesService.getScriptProperties().setProperty(WORKSPACE_REPAIR_DEFAULT_WORKSPACE_KEY_, value);
  Logger.log('Default workspace repair ID set: %s', value);
  return value;
}
