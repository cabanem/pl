# Host changes for DrivePicker v2 (picker helper)

Against the "models-and-access" delivery. Full corrected files are alongside; picker-v2-host.patch is the diff.

1. Config sheet: delete the rows `picker_api_key`, `picker_client_id`, `picker_app_id`. Add ONE row:
   `picker_url` = the DrivePicker project's web-app /exec URL (README §4.5). Presence is the switch.
2. `ContractIntake.js`: the Config typedef and readConfig_ read `picker_url` instead of the three keys.
3. `WebApp.js`: `pickerConfig_` returns `{ url, mimeTypes }` when `picker_url` is set, else null.
4. `Dashboard.html`: `mountPicker` passes `url: p.url` to `DrivePicker.mount` (no apiKey/clientId/appId).
5. `appsscript.json`: bump the DrivePicker library `version` to the number from README §4.6; `developmentMode: false`.
6. `Tests.js`: one new case for `pickerConfig_`.
Then `clasp push` and a new web-app deployment version. First click: see README §6.
