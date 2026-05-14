# REV-01 decision mapping
# decision -> (target_state, trigger_context)
# Source of truth: STS-01 v29 trigger_context enum + REV-01 substage 4.
# Note: "rework" is the state-machine term; "reject" is colloquial analyst-facing.

DECISION_MAP = {
    "approve": {
        "target_state": "approved",
        "trigger_context": "analyst_approve",
    },
    "reject": {
        "target_state": "supplier_action_required",
        "trigger_context": "analyst_rework",
    },
}


def main(input):
    decision = (input.get("decision") or "").strip().lower()
    mapping = DECISION_MAP.get(decision)
    if mapping is None:
        # Substage 2 should have caught this; defensive fallback.
        return {"target_state": "", "trigger_context": ""}
    return {
        "target_state": mapping["target_state"],
        "trigger_context": mapping["trigger_context"],
    }
