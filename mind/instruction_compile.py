#!/usr/bin/env python3
"""instruction_compile.py — compile the canonical's GOVERNANCE into the agent-readable
policy document (V0.3.1).

Two compiled artifacts, two axes, one pattern:

  briefing.md            <- current.yaml      what is BELIEVED   (state)   -> ContextEnvelope
  instruction/generated.md    <- governance.yaml   how to OPERATE     (authority) -> InstructionEnvelope

`host/src/app/host.js` already mounts `<canonical>/instruction/generated.md` as
`InstructionEnvelope.instructions`; nothing was producing it, so the model was
never told the rules it is subject to. This is the missing producer.

Two kinds of content, kept apart on purpose:

  RENDERED from the canonical (authority — §1, §2, §4, §5, §7):
    u0_constitutional.root_authorities    who holds which authority
    u0_constitutional.revision_rules      the standing revision rules
    normative_authorities                 whose word is normative, over what
    u1_evolvable.update_classes           how each class of change must be made
    policy.json                           the enforcement posture

  STATED, not rendered (§3 invariants, §6 procedure): the operating discipline
  itself. It has no canonical source — it is the theory's operating rules, and
  before this file existed it lived only in a skill that pi never loads.

`revision_rules` is the reason this file exists: it contains
`predict-before-change`, which the world-model gate enforces and which appeared
NOWHERE the agent could read.

Usage:
  python mind/instruction_compile.py --canonical <canonicalDir> [--out <dir>]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    raise SystemExit("PyYAML required")

# Two-tier budget, mirroring the briefing's (canonical_compile.py): TARGET_MAX is
# what the slot aims for, HARD_CAP is where content is actually dropped.
#
# Using the target AS the cap was actively harmful: the real pilot canonical
# compiles to 7385 B, so it was cut mid-sentence — losing §6's operational steps
# (predict / act / observe / evaluate) while still exiting 0-looking like a
# "capacity" problem. The declared budget in soul/manifest.json has room to 8192,
# so over-target is a WARNING and only over-hard-cap is a failure.
TARGET_MAX = 6 * 1024
HARD_CAP = 8 * 1024

# Stated, not rendered — see the module docstring. Kept verbatim in meaning from
# skills/world-model-runtime/SKILL.md (the only prior home).
INVARIANTS = [
    # Invariant 1 is scoped, not absolute. theory-v0.5 §三 states the two-track
    # reading as the formal one, and says in terms: the "prediction precedes
    # observation" gate is the EVALUATION track's hard gate for testing an
    # existing model — exploratory observation, anomaly discovery and first-time
    # modelling may and must come BEFORE any prediction, or H4 can never trigger.
    # Writing it unconditionally would forbid discovery, which is the opposite of
    # what the discipline is for.
    "**Prediction precedes the observation that TESTS it.** When you are testing "
    "an existing model, write down what you expect to see if it is right, then act "
    "and look — a prediction written after the result is not a prediction. This "
    "gate is the EVALUATION track's, not a universal law: exploratory observation, "
    "anomaly discovery and first-time modelling come BEFORE any prediction, and "
    "must be allowed to. What is forbidden is passing off a post-hoc explanation "
    "as a prediction.",
    "**RAW_EVIDENCE ≠ OBSERVATION ≠ Interpretation.** A tool result is raw "
    "evidence; it becomes an observation when you select, mark and bind it to a "
    "prediction. Its existence in the log does not support you.",
    # D2 (conformance-rubric §四): the key quantity is the LIKELIHOOD RATIO — how
    # much better the evidence fits one hypothesis than its rival — not a bare
    # probability. Strong evidence can flip the ordering. And the second half of
    # D2 is easy to drop: Bayes rules only evidence→belief; where hypotheses come
    # from is H4, a different problem.
    "**Weigh evidence BETWEEN hypotheses.** What moves belief is the LIKELIHOOD "
    "RATIO — how much better this fits one hypothesis than its rival. 'Looks "
    "likely' is not that. A claim whose rivals predict the same thing cannot gain "
    "confidence from evidence at all. (Limit: this governs evidence→belief only; "
    "where a hypothesis comes from is H4, not this.)",
    # S5 (conformance-rubric §三): the requirement is CONDITIONAL, and both halves
    # matter. With real uncertainty a lone hypothesis is the named defect; without
    # it, manufacturing rivals is the formalism the rubric also warns against.
    "**Competing hypotheses — only where the uncertainty is real.** With real "
    "uncertainty a lone hypothesis is a defect: register the rivals and what would "
    "retire each. Without it, inventing rivals is formalism.",
    "The defect is 'real uncertainty, one hypothesis', never 'one hypothesis'.",
    # The five states come verbatim from conformance-rubric §三 S4. They are not
    # decoration: each one points at a DIFFERENT remedy, and a bare UNKNOWN points
    # at none. The rubric also says the taxonomy existing does not oblige every
    # model object to carry all five as physical fields (that is a schema choice)
    # — so the requirement here is that the STATE is named, not that it is
    # separately fielded.
    # Continuation lines are indented, not re-bulleted: the renderer prefixes
    # every INVARIANTS entry with "- ", so a dashed sub-list would come out as
    # "-   - ".
    "**Unknown is not filled in — and unknown is not one thing.** If you do not "
    "know, never manufacture a value; write UNKNOWN *and say which kind*, because "
    "each kind has a different remedy:",
    "    **no data** — nothing observed yet → go get it",
    "    **insufficient evidence** — some, not enough → gather more before deciding",
    "    **conflict** — sources disagree → find the observation that separates them",
    "    **outside the model** — nothing you have can express it → the model space "
    "itself is what must change (this is what H4 is for)",
    "    **unidentifiable** — no amount of data would settle it → stop, and say so; "
    "more evidence will not help",
    "    A bare UNKNOWN hides which remedy applies. Say the kind.",
    "**World / Value / Decision stay separate.** How the world works ≠ what is "
    "worth wanting ≠ which action to take.",
    "**A major update leaves a recoverable artifact.** Write it into state, not "
    "only into the conversation.",
    "**State files are audit objects.** Persist facts, models, predictions, "
    "observations, decision grounds and evidence refs — not the full text of "
    "private reasoning.",
]


def load(p: Path) -> dict:
    if not p.exists():
        return {}
    d = yaml.safe_load(p.read_text(encoding="utf-8"))
    return d if isinstance(d, dict) else {}


def build(gov: dict, policy: dict) -> str:
    u0 = gov.get("u0_constitutional") or {}
    roots = u0.get("root_authorities") or {}
    rules = u0.get("revision_rules") or []
    na = gov.get("normative_authorities") or {}
    u1 = (gov.get("u1_evolvable") or {}).get("update_classes") or {}
    ver = gov.get("policy_version")

    out: list[str] = []
    out.append("# Operating policy")
    out.append("")
    out.append("Rules you operate under. Rendered from the canonical; the canonical "
               "governs — this is its agent-readable form.")
    if ver is not None:
        out.append(f"policy_version: {ver}")
    out.append("")

    # 1. Who holds authority. Normative authority is NEVER derived from
    #    epistemic reliability (governance.yaml states this explicitly).
    if roots:
        out.append("## 1. Authority")
        for k, v in roots.items():
            out.append(f"- **{k}**: {v}")
        if na.get("note"):
            out.append(f"- note: {na['note']}")
        out.append("")

    # 2. The standing revision rules. `predict-before-change` is first for a
    #    reason: it is what the world-model gate enforces.
    if rules:
        out.append("## 2. Revision rules (standing)")
        for r in rules:
            out.append(f"- {r}")
        out.append("")
        if "predict-before-change" in rules:
            out.append("`predict-before-change` is enforced, not advisory: a consequential "
                       "mutation will be REFUSED until an open prediction binds to it. "
                       "See §6 for how to discharge it.")
            out.append("")
    else:
        # A declared section must not vanish without a trace. This is the section
        # the artifact exists for (soul/instruction/template.md), and omitting it
        # silently would read as "there are no standing rules" rather than "they
        # were not declared here" — the reader cannot tell those apart.
        out.append("## 2. Revision rules (standing)")
        out.append("- NOT DECLARED: this instance's governance has no "
                   "`u0_constitutional.revision_rules`. The written standing rules are "
                   "not available to you here. `predict-before-change` is still "
                   "ENFORCED by the gate (see §6); what is missing is the list.")
        out.append("")

    # 3. The invariants — the operating discipline that makes the ledger mean
    #    anything. Stated, not rendered: no canonical carries them, and before
    #    this file existed they lived only in skills/world-model-runtime, which
    #    pi never loads (noSkills: true). Invariant 1 is the operational form of
    #    rule §2[0].
    out.append("## 3. Invariants (violating any one voids the protocol)")
    for inv in INVARIANTS:
        # An entry that starts with a space is a CONTINUATION of the previous
        # invariant (the five unknown-kinds hang off the unknown invariant), so
        # it is emitted verbatim rather than re-bulleted.
        out.append(f"- {inv}" if not inv.startswith(' ') else inv)
    out.append("")

    # 4. Whose word is normative, over what.
    scopes_any = False
    for who, body in na.items():
        if who == "note" or not isinstance(body, dict):
            continue
        sc = body.get("scopes")
        if not sc:
            continue
        if not scopes_any:
            out.append("## 4. Normative scopes")
            scopes_any = True
        if isinstance(sc, list):
            out.append(f"- **{who}**: {', '.join(str(x) for x in sc)}")
        else:
            out.append(f"- **{who}**: {sc}")
    if scopes_any:
        out.append("")
    else:
        out.append("## 4. Normative scopes")
        out.append("- NOT DECLARED: `normative_authorities` carries no `scopes`, so you "
                   "cannot tell from this artifact whose word is normative over what.")
        out.append("")

    # 4. How each class of change must be made.
    if u1:
        out.append("## 5. How each class of change is made")
        for k, v in u1.items():
            out.append(f"- **{k}**: {v}")
        out.append("")
        out.append("A change made outside its class pipeline is not a change you are "
                   "authorized to make; it is a proposal at best.")
        out.append("")
    else:
        out.append("## 5. How each class of change is made")
        out.append("- NOT DECLARED: `u1_evolvable.update_classes` is absent, so no change "
                   "pipeline is stated here. Do not infer one from the other sections.")
        out.append("")

    # 5. Discharging predict-before-change. The loop below is the operational
    #    form of rule §2[0]; it is the same for every instance, so it is stated
    #    here rather than derived.
    out.append("## 6. Discharging predict-before-change")
    out.append("Before a consequential change, in order:")
    out.append("0. **Expect something of your own inputs.** Invariant 1 is not only "
               "about the world: it applies to what you are given. Before acting, you "
               "hold an expectation about what you should have received — prior state, "
               "the rules you operate under, the record of what you have done. If any "
               "of that is ABSENT, that is not a neutral fact to absorb silently: a "
               "prediction that failed to arrive is a refuted prediction. Say what you "
               "expected, that it did not arrive, and that you do not know why. Never "
               "enumerate your channels from memory — the one you forgot is the one "
               "that is broken.")
    out.append("1. `world_model(op:\"activate\")` — declare this session's formalization "
               "depth. The depth may be raised, never lowered.")
    out.append("   The discriminant is NOT how big or how risky the task is: it is "
               "whether the decision-critical state can be carried by ORDINARY "
               "artifacts. If it can, ordinary artifacts suffice and the depth stays "
               "low; if it cannot, the depth rises. (Complexity, cross-component "
               "reach and mutation were each tested as discriminants and eliminated — "
               "do not use them. This discriminant is validated within one pilot "
               "scope, not a general truth.)")
    out.append("2. `world_model(op:\"predict\")` — state the intended action, the "
               "observation you expect, and the falsifier. Set `irreversible:true` when "
               "the action cannot be undone.")
    out.append("3. Act. The gate admits the call only against an OPEN, UNEVALUATED "
               "prediction that names the tool and its target.")
    out.append("4. `world_model(op:\"observe\")` — record what was actually seen. "
               "Unknown is a legitimate observation; it is not filled in.")
    out.append("5. `world_model(op:\"evaluate\")` — confirmed or refuted, against the "
               "falsifier you wrote, not against whether the work succeeded.")
    out.append("6. `world_model(op:\"update\")` — only after evaluation. A model "
               "revision that references an unevaluated prediction is refused.")
    out.append("7. `world_model(op:\"persist\")` — persist the working state.")
    out.append("")
    out.append("Evidence is captured mechanically whether or not you follow this; the "
               "ledger is append-only and survives you. What the loop buys is that a "
               "prediction exists BEFORE the change, so being wrong is legible.")

    # 6. Machine-readable authority, for reference.
    if policy:
        out.append("")
        out.append("## 7. Enforcement posture (from policy.json)")
        ra = policy.get("riskActions")
        if isinstance(ra, dict) and ra:
            out.append("- riskActions: " + ", ".join(f"{k}={v}" for k, v in ra.items()))
        denied = [k for k, v in (policy.get("tools") or {}).items()
                  if isinstance(v, dict) and v.get("action") == "deny"]
        if denied:
            out.append("- denied tools (hidden from you): " + ", ".join(sorted(denied)))
        out.append("- policy.json is attested; if it drifts under a live session the "
                   "runtime fails closed rather than continuing.")

    text = "\n".join(out).rstrip() + "\n"
    raw = len(text.encode("utf-8"))
    truncated_from = None
    if raw > HARD_CAP:
        # Never silent. A cap that quietly eats the tail is the same failure this
        # whole section is about: the loss leaves no signal, so nobody notices
        # that the instruction the agent receives is not the one that was written.
        truncated_from = raw
        text = text.encode("utf-8")[:HARD_CAP].decode("utf-8", "ignore").rstrip() + "\n"
    return text, truncated_from


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--canonical", required=True, help="canonical dir")
    ap.add_argument("--out", default=None,
                    help="output dir (default: <canonical>/policy)")
    args = ap.parse_args()

    canon = Path(args.canonical)
    if not canon.exists():
        raise SystemExit(f"no canonical at {canon}")
    gov = load(canon / "governance.yaml")
    if not gov:
        raise SystemExit(f"governance.yaml missing or empty at {canon} — policy has no source")
    policy = {}
    pj = canon / "policy.json"
    if pj.exists():
        try:
            policy = json.loads(pj.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise SystemExit(f"policy.json is not valid JSON: {e}")

    out_dir = Path(args.out) if args.out else canon / "instruction"
    out_dir.mkdir(parents=True, exist_ok=True)
    text, truncated_from = build(gov, policy)
    (out_dir / "generated.md").write_text(text, encoding="utf-8")
    n = len(text.encode("utf-8"))
    report = {
        "wrote": str(out_dir / "generated.md"),
        "bytes": n,
        # `cap` is kept as the hard cap so that bytes + headroom_bytes == cap stays
        # true for existing readers; the two tiers are reported explicitly.
        "cap": HARD_CAP,
        "target_max_bytes": TARGET_MAX,
        "hard_cap_bytes": HARD_CAP,
        "over_target": n > TARGET_MAX,
        "headroom_bytes": HARD_CAP - n,
        "source": {"governance": str(canon / "governance.yaml"),
                   "policy": str(pj) if pj.exists() else None},
    }
    if report["over_target"] and truncated_from is None:
        # Delivered in full, but past what the slot aims for. Visible here, and in
        # the artifact's own size — not a failure, but not nothing either.
        report["OVER_TARGET"] = {
            "bytes": n,
            "target_max_bytes": TARGET_MAX,
            "why": "the slot's target is a budget, not a cliff; this shipped whole. "
                   "Trim the source or raise the declared target — do not let it drift "
                   "up without anyone deciding.",
        }
    if truncated_from is not None:
        # Loud, and non-zero exit: the artifact on disk is NOT what was written.
        report["TRUNCATED"] = {
            "would_have_been_bytes": truncated_from,
            "cap": HARD_CAP,
            "hard_cap_bytes": HARD_CAP,
            "why": "the instruction slot has a per-turn budget; content past the HARD cap "
                   "was dropped. Trim the source, split the section, or raise the "
                   "declared hard cap — do not let this pass as a normal compile.",
        }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 2 if truncated_from is not None else 0


if __name__ == "__main__":
    sys.exit(main())
