Before changing anything, check one thing: is it an actual `FAIL` line in the test summary, or just a red warning in the execution log? One of the tests *deliberately* provokes a failed fetch in non-strict mode ("unreadable recipe degrades to []"), and its `console.warn` — `Could not fetch details for recipe 99999: 404` — shows up in the GAS execution log looking like an error even when all 17 checks pass. If the summary says `0 failures`, you're done; that log line is the test doing its job.

If it's a genuine `FAIL` on the PRV-01 tests with `fetch failed for recipe 90001`, then here's the mechanism, and I'd bet on cause #1:

The strict "fetch failed" throw only fires when `getCallEdges(90001)` **misses the cache** and falls through to the mock client (which serves nothing → 404). So `primeCache` didn't actually register the fixture. And there's a subtle trap I set without realizing it: **the raw export files you uploaded have no `id` field.** Their top-level keys are `name, description, version, code, config, tags...` — the recipe ID isn't part of the RLM export format. My trimmed fixture *added* `"id": 90001` at the top. If you pasted the original export JSON (or re-trimmed it yourself from the upload) instead of the contents of `fixture_prv01_trimmed.json`, then `primeCache` hits its guard — `r.id !== undefined` — skips the record silently, returns 0, and the very next read goes to the network path.

Two 30-second probes in the harness:

```javascript
function probeFixture() {
  Logger.log('type: ' + typeof FIXTURE_PRV01);          // must be 'object', not 'string'
  Logger.log('id: ' + FIXTURE_PRV01.id);                 // must be 90001, not undefined
  const an = newAnalyzer(newMockClient({}), { STRICT: true });
  Logger.log('cache size: ' + an.primeCache([FIXTURE_PRV01]));  // must be 1
}
```

Whichever probe fails tells you the fix: `id: undefined` → you pasted the export shape; add `"id": 90001` at the top level (or use the trimmed fixture file as-is). `type: string` → the JSON got pasted inside quotes; remove them so it's an object literal. (In live use this never bites — the API's list endpoint always includes `id` — it's purely a fixture-format hazard.)

And notice what just happened, because it's your disease in miniature: `primeCache` *silently skipped* a malformed record and returned a count nobody checked — a swallow inside the anti-swallow tooling. Worth a one-line hardening while you're in there:

```javascript
  primeCache(recipes) {
    let skipped = 0;
    (recipes || []).forEach(r => {
      if (r && r.id !== undefined && r.id !== null) {
        this._recipeDetailCache.set(String(r.id), r);
      } else { skipped++; }
    });
    if (skipped && this.CONSTANTS.STRICT) {
      throw new Error(`GraphLib[strict]: primeCache skipped ${skipped} record(s) without an id.`);
    }
    if (skipped) console.warn(`GraphLib: primeCache skipped ${skipped} record(s) without an id.`);
    return this._recipeDetailCache.size;
  }
```

With that in place, this exact failure mode announces itself at the boundary — pasted-wrong fixture, malformed API response, whatever — instead of surfacing three calls later as a confusing 404. Assert the magic number at the boundary, as someone once put it about XLSX bytes.
