"""Proof-of-concept lifecycle for audit findings.

The contract this module will enforce (Sprint 2):

    detect → generate PoC → replay PoC in an independent process
           → only a successful replay promotes a candidate to a finding

A model's claim that "this is vulnerable" is a candidate, never a
finding. The replay runs outside the proposing agent's context, through
the same gating and event chain as any other consequential action, so
the audit trail records who verified what and when. A candidate whose
PoC cannot be replayed is reported as such — with the failure reason —
not silently dropped and not silently promoted.
"""
