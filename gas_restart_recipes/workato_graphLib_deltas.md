# WorkatoGraphLib — Watchdog-Hardening Deltas

Four edits against v1.0.0 as shared. Backward compatible: doc/Mermaid consumers
see identical behavior unless `STRICT` is enabled. Apply in order.

---

## Delta 1 — Constructor: strict mode + call-action vocabulary

**Why:** Watchdog consumers must fail loudly on unreadable recipes, and edge
extraction must distinguish `call_recipe`/`call_recipe_async` from
`return_result` (all three share provider `workato_recipe_function`).

**OLD**
```javascript
    // Default constants (can be overridden)
    this.CONSTANTS = {
      RECIPE_PROVIDERS: config.RECIPE_PROVIDERS || ['workato_recipe_function', 'workato_callable_recipe'],
      FLOW_ID_KEYS: config.FLOW_ID_KEYS || ['flow_id', 'recipe_id', 'callable_recipe_id'],
      MERMAID_LABEL_MAX: config.MERMAID_LABEL_MAX || 80
    };
```

**NEW**
```javascript
    // Default constants (can be overridden)
    this.CONSTANTS = {
      RECIPE_PROVIDERS: config.RECIPE_PROVIDERS || ['workato_recipe_function', 'workato_callable_recipe'],
      FLOW_ID_KEYS: config.FLOW_ID_KEYS || ['flow_id', 'recipe_id', 'callable_recipe_id'],
      // Step names (on RECIPE_PROVIDERS steps) that constitute an invocation.
      // Excludes 'return_result', which shares the provider but calls nothing.
      CALL_ACTION_NAMES: config.CALL_ACTION_NAMES || ['call_recipe', 'call_recipe_async'],
      MERMAID_LABEL_MAX: config.MERMAID_LABEL_MAX || 80,
      // Strict mode: parse/fetch failures THROW instead of warn-and-degrade.
      // Documentation callers keep the default (false). The watchdog sets true,
      // because "no edges" and "couldn't read" must never be the same answer.
      STRICT: config.STRICT || false
    };
```

---

## Delta 2 — `getRecipeDetails` / `getCallEdges`: honest failure

**Why:** Both currently swallow errors and return a value indistinguishable
from a legitimate empty result. In strict mode, rethrow.

**OLD** (in `getRecipeDetails`)
```javascript
    } catch (e) {
      console.warn(`GraphLib: Could not fetch details for recipe ${key}: ${e.message}`);
      return null;
    }
```

**NEW**
```javascript
    } catch (e) {
      if (this.CONSTANTS.STRICT) {
        throw new Error(`GraphLib[strict]: fetch failed for recipe ${key}: ${e.message}`);
      }
      console.warn(`GraphLib: Could not fetch details for recipe ${key}: ${e.message}`);
      return null;
    }
```

**OLD** (in `getCallEdges`)
```javascript
    } catch (e) {
      console.warn(`GraphLib: Error parsing call edges for ${recipeId}: ${e.message}`);
    }
    return edges;
```

**NEW**
```javascript
    } catch (e) {
      if (this.CONSTANTS.STRICT) {
        throw new Error(`GraphLib[strict]: code parse failed for recipe ${recipeId}: ${e.message}`);
      }
      console.warn(`GraphLib: Error parsing call edges for ${recipeId}: ${e.message}`);
    }
    return edges;
```

Also add, in strict mode, a guard at the top of `getCallEdges` — a managed
recipe with no code is a finding, not a shrug:

**OLD**
```javascript
    const json = this.getRecipeDetails(recipeId);
    if (!json || !json.code) return [];
```

**NEW**
```javascript
    const json = this.getRecipeDetails(recipeId);
    if (!json || !json.code) {
      if (this.CONSTANTS.STRICT) {
        throw new Error(`GraphLib[strict]: recipe ${recipeId} has no retrievable code.`);
      }
      return [];
    }
```

---

## Delta 3 — `_scanBlockForCallEdges`: classified edges, normalized callee refs

**Why (three problems, one rewrite):**

1. The old `looksLikeCall` was decorative — the push required `found` anyway,
   so ANY step whose input mentioned a `flow_id`-ish key within depth 3 became
   an edge, regardless of provider. Phantom edges are noise in a diagram and
   false dependencies (or false cycles) in an ordering graph.
2. Callee references come in TWO shapes. Live API (`GET /recipes/:id`):
   `flow_id` is a **numeric ID**. RLM/package exports: `flow_id` is a
   **symbolic object** `{zip_name, name, folder}` (confirmed in PRV-01/PRV-04).
   The old code stringified whatever it found — a symbolic ref became
   `"[object Object]"`.
3. A datapill callee (`#{_dp(...)}`) is a runtime-dispatched call: statically
   unorderable by definition. It must be surfaced, never silently ordered.

Every edge now carries `child_ref` with a `kind` discriminator, plus
`call_type` (sync/async) and `strength`:

- `strong`  — provider match + call-action name + resolvable ref. Orderable.
- `weak`    — an ID key found on a NON-recipe provider step. Logged, never ordered.
- `dynamic` — call step whose callee is a datapill/expression. Surfaced as a finding.

**OLD** (entire forEach body up to the Branch Context comment)
```javascript
      const stepPath = ctx.stepPathPrefix ? `${ctx.stepPathPrefix}/${index}` : `${index}`;
      const input = step?.input || {};
      const found = this._findIdKeyAndValue(input, this.CONSTANTS.FLOW_ID_KEYS, 3);
      const looksLikeCall = Boolean(found) || this.CONSTANTS.RECIPE_PROVIDERS.includes(step?.provider);

      if (looksLikeCall && found && found.value) {
        edges.push({
          parent_recipe_id: ctx.parentId, parent_recipe_name: ctx.parentName,
          child_recipe_id: String(found.value), id_key: found.key,
          provider: step.provider || "unknown", step_name: step.name || step.as || "Unknown",
          step_path: stepPath, branch_context: (ctx.branchStack || []).join(" / ")
        });
      }
```

**NEW**
```javascript
      const stepPath = ctx.stepPathPrefix ? `${ctx.stepPathPrefix}/${index}` : `${index}`;
      const input = step?.input || {};
      const found = this._findIdKeyAndValue(input, this.CONSTANTS.FLOW_ID_KEYS, 3);

      const isRecipeProvider = this.CONSTANTS.RECIPE_PROVIDERS.includes(step?.provider);
      const isCallAction = isRecipeProvider &&
        this.CONSTANTS.CALL_ACTION_NAMES.includes(String(step?.name || ""));

      if (found && found.value) {
        const ref = this._classifyCalleeRef(found.value);
        const strength = isCallAction
          ? (ref.kind === "dynamic" ? "dynamic" : "strong")
          : "weak"; // ID-shaped key on a non-call step: report, don't order

        edges.push({
          parent_recipe_id: ctx.parentId, parent_recipe_name: ctx.parentName,
          // Backward compat: numeric refs keep the old field populated;
          // symbolic/dynamic refs leave it "" and consumers use child_ref.
          child_recipe_id: (ref.kind === "id") ? ref.id : "",
          child_ref: ref,
          strength: strength,
          call_type: String(step.name || "").includes("async") ? "async" : "sync",
          id_key: found.key,
          provider: step.provider || "unknown", step_name: step.name || step.as || "Unknown",
          step_path: stepPath, branch_context: (ctx.branchStack || []).join(" / ")
        });
      } else if (isCallAction) {
        // A call step with NO resolvable target at all — worst case, always surface.
        edges.push({
          parent_recipe_id: ctx.parentId, parent_recipe_name: ctx.parentName,
          child_recipe_id: "", child_ref: { kind: "dynamic", raw: null },
          strength: "dynamic",
          call_type: String(step.name || "").includes("async") ? "async" : "sync",
          id_key: null,
          provider: step.provider || "unknown", step_name: step.name || step.as || "Unknown",
          step_path: stepPath, branch_context: (ctx.branchStack || []).join(" / ")
        });
      }
```

And add one helper to **Internal utilities**:

```javascript
  /**
   * Normalizes a callee reference into a discriminated shape.
   * Live API: numeric ID. Package export: {zip_name, name, folder}.
   * Anything else (datapill, expression): dynamic — statically unorderable.
   * @private
   */
  _classifyCalleeRef(value) {
    if (value && typeof value === "object") {
      if (value.zip_name || value.name) {
        return { kind: "symbolic",
                 zip_name: value.zip_name || "", name: value.name || "" };
      }
      return { kind: "dynamic", raw: JSON.stringify(value).slice(0, 200) };
    }
    const s = String(value);
    if (/^\d+$/.test(s)) return { kind: "id", id: s };
    return { kind: "dynamic", raw: s.slice(0, 200) };
  }
```

**Ripple check on existing consumers:** `_pClassifyStep` (process graph) still
uses `found || provider` to label a node "call" — fine, that's cosmetic.
Mermaid call-graph rendering skips edges with empty `child_recipe_id` (it
already guards `if (!p || !c) return`), so symbolic edges silently vanish from
diagrams built from export files. If you want them drawn, resolve first (Delta
4 + OrderLib resolver) — but nothing breaks.

---

## Delta 4 — `primeCache`: one list call feeds everything

**Why:** The list endpoint returns `code` per recipe; priming the existing
`_recipeDetailCache` from one paginated call turns ~58 GETs per watchdog run
into 1. Add to the public interface:

```javascript
  /**
   * Pre-populates the recipe detail cache from list-endpoint results,
   * so subsequent getCallEdges/getRecipeDetails calls are cache hits.
   * @param {Array<Object>} recipes - e.g. client.fetchPaginated('recipes?folder_id=...')
   * @returns {number} Cache size after priming.
   */
  primeCache(recipes) {
    (recipes || []).forEach(r => {
      if (r && r.id !== undefined && r.id !== null) {
        this._recipeDetailCache.set(String(r.id), r);
      }
    });
    return this._recipeDetailCache.size;
  }
```

Cache lifetime = one GAS execution = one watchdog run. The graph is recomputed
from reality every run by construction; staleness is structurally impossible.

---

## Typo housekeeping (optional, zero behavior change)

`PRIAMRY CLIENT CLASS` / `PRIAMRY ANALYSIS CLASS` → `PRIMARY`;
`@param {Object} otpions` → `options`; `Error Parinsg` → `Parsing`.
Worth fixing before the boundary-knowledge write-up ships excerpts.
