"""workspace_selftest — offline proof of the Workspace facade.

Drives Workspace against the same fake transport fetch_selftest uses (no
network), and proves the properties the facade adds on top of the spine:

  * handle <-> flow_id resolution (including the unknown-handle refusal)
  * facts/oracle parity with the script path (same ORACLE, same green)
  * a custom answer key producing an honest red
  * the memoized snapshot — re-asking costs zero HTTP calls
  * refresh() actually dropping the snapshot
  * vocabulary + production scoping + the single-owner audit

Exits 0 on green.
"""
from __future__ import annotations

import os

from workato_client import WorkatoClient, WorkatoConfig
from fetch_selftest import make_fake_transport, FOLDER_ID, STS01_FLOW_ID
from slice_run import ORACLE
from workspace import Workspace


def counting_transport(inner):
    """Wrap a transport so every HTTP call is recorded — the instrument that
    makes the memoization claim testable instead of asserted."""
    calls: list = []

    def transport(method, url, headers, body):
        calls.append(url)
        return inner(method, url, headers, body)

    transport.calls = calls
    return transport


def main():
    # The selftest must not inherit live-workspace scoping from the shell.
    os.environ.pop("SDC_RECIPES_FOLDER_ID", None)
    os.environ.pop("SDC_RECIPES_FOLDER_NAME", None)

    transport = counting_transport(make_fake_transport())
    client = WorkatoClient(
        config=WorkatoConfig.from_env({"WORKATO_API_TOKEN": "fake-token"}),
        transport=transport,
        sleep=lambda _s: None,
    )
    ws = Workspace.connect(folder_id=FOLDER_ID, client=client)

    # -- identity -----------------------------------------------------------
    assert ws.flow_id("STS-01") == STS01_FLOW_ID
    assert ws.flow_id(STS01_FLOW_ID) == STS01_FLOW_ID
    assert ws.flow_id(str(STS01_FLOW_ID)) == STS01_FLOW_ID
    assert ws.handle(STS01_FLOW_ID) == "STS-01"
    try:
        ws.flow_id("NOPE-99")
        raise AssertionError("unknown handle should raise KeyError")
    except KeyError:
        pass
    print("[ok] identity: handle <-> flow_id both ways; unknown handle refuses")

    # -- facts + oracle parity with the script path --------------------------
    facts = ws.facts("STS-01")
    for key, expected in ORACLE.items():
        assert facts[key] == expected, f"facts[{key}] != ORACLE"
    result = ws.oracle("STS-01")
    assert result.ok and bool(result), "oracle should be green against the canned STS-01"
    assert result.diff == {}
    print("[ok] oracle: green against the shared ORACLE, same answer as real_oracle")
    print()
    print(result)
    print()

    # -- a custom answer key produces an honest red ---------------------------
    red = ws.oracle("STS-01", expected={"writes": {"NotARealTable"}})
    assert not red.ok and "writes" in red.diff
    assert red.diff["writes"]["missing"] == {"NotARealTable"}
    print("[ok] oracle: custom expected produces red with the right diff")

    # -- memoization: re-asking is free ---------------------------------------
    before = len(transport.calls)
    ws.facts("STS-01")
    ws.oracle("STS-01")
    ws.edges("STS-01")
    assert len(transport.calls) == before, (
        f"snapshot re-fetched: {transport.calls[before:]}")
    print(f"[ok] snapshot: {before} HTTP calls total; three more questions cost zero")

    # -- vocabulary + samples --------------------------------------------------
    vocab = ws.vocabulary()
    assert any("db_table" in p for p in vocab.providers), vocab.providers
    assert "trigger" in vocab.keywords
    assert ws.samples("workato_db_table"), "samples should surface db_table steps"
    n_after_vocab = len(transport.calls)
    ws.vocabulary()                                   # memoized corpus
    assert len(transport.calls) == n_after_vocab
    print("[ok] vocabulary: inspector readout produced; corpus fetched once")
    print()
    print(vocab)
    print()

    # -- production scope + audit ----------------------------------------------
    prod = ws.production_recipes()
    assert ("STS-01" in {h for _f, h in prod}), prod
    audit = ws.audit()
    assert audit["owner"] == "STS-01"
    assert set(audit["guarded_columns"]) == ORACLE["status_columns"]
    print(f"[ok] audit: production set {sorted(h for _f, h in prod)}; "
          f"other_writers={audit['other_writers']}")

    # -- refresh drops the snapshot ---------------------------------------------
    n = len(transport.calls)
    ws.refresh()
    ws.facts("STS-01")
    assert len(transport.calls) > n, "refresh() should force a re-capture"
    print("[ok] refresh: snapshot dropped, next question re-captured live state")

    print("\nworkspace selftest green: the facade answers every heredoc question offline.")


if __name__ == "__main__":
    main()
