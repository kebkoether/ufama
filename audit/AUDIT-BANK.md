# Soroban Security Audit Bank — application pack

What SDF's Audit Bank requires, what we already have, what is missing,
and the email that requests the intake form. Sources read 2026-11-02:
program page (stellar.org/grants-and-funding/soroban-audit-bank), the
Official Rules, Audit Readiness Checklist and FAQ in the SCF Handbook
(stellar.gitbook.io/scf-handbook/supporting-programs/audit-bank), and
the published audits list (stellar.org/audit-bank/projects).

## How the program works

- Run by SDF under the Stellar Community Fund. There is **no public
  form**: the intake form arrives by email. Contacts:
  **sorobanaudits@stellar.org** (program) and
  **communityfund@stellar.org** (request the form).
- SDF covers up to 100% of the audit at pre-negotiated rates with
  pre-approved firms (Certora, Code4rena, ChainSecurity, Halborn, Oak
  Security, OtterSec, Runtime Verification, Spearbit/Cantina, Veridise,
  Zellic; probationary: Arda, Hacken, Sherlock, Quantstamp, Hashlock,
  Decurity, Adevar Labs, Bevor). The project may state a firm preference.
- **Co-pay**: 5% of the initial audit cost, paid before the audit starts,
  **refunded in full** if every critical/high/medium finding is fixed
  within 20 business days and verified by the firm. Follow-up audits
  before traction milestones: 20% then 50%.
- Phases: intake and eligibility → readiness review by an SDF security
  expert (1–4 weeks) → firm matching (~2 weeks) → scheduling (firms book
  3–6 weeks out) → audit (2–8 weeks) → remediation (20 business days) →
  verification → **public report**, listed on stellar.org/audit-bank.
- Participants consent to SDF using the project name and logo for three
  years. SDF recommends a separate confidentiality agreement with the
  firm.

## Eligibility, line by line (Official Rules)

| Rule | ufama today |
|---|---|
| Funded by SCF (no other SDF commercial grant) | **Not SCF-funded.** The head of ecosystem said to skip SCF and come straight to the bank. Every published rule says SCF funding is required, and the intake form "is provided to SCF-funded projects". Several 2026 audited projects do not appear on the SCF site, so discretionary intake exists but is undocumented. Ask for it explicitly, naming who sent us. |
| Pass KYC and sanctions checks | Individuals are accepted (SDF's KYC form covers "individuals or businesses"). No entity needed. |
| Eligible priority category | **Financial Protocols** ("protocols managing on-chain value") — no traction threshold for priority categories. |
| Code complete, nearly mainnet-ready, audit needed in 4–6 weeks | Live on mainnet since 2026-08 (v1.2.1 set) and 2026-10 (RfqSettle). Code frozen for the audit once pre-audit fixes land. |
| Extensive tests, deployed on testnet | 75 contract unit tests plus the cross-contract integration crate; every contract was deployed and exercised on testnet before mainnet. |
| Self-service tooling scan results + remediation plan for crit/high/med | [SCANS.md](./SCANS.md) (Scout, cargo audit, clippy; 2026-11-05, all nine crates incl. RfqSettle and Curve) and [REMEDIATION.md](./REMEDIATION.md). |
| STRIDE threat model | [THREAT_MODEL.md](../THREAT_MODEL.md): dataflow diagram with trust boundaries, 26 threats across six boundaries, per SDF's template. **Add the RFQ flow** (maker pre-signed auth entry, NAV band) — it postdates the model. |
| Responsive during the audit | One maintainer, full-time available. |
| Able to pay the co-pay | 5% of the audit cost, refundable. Budget for it. |

## What the intake form asks (per the rules) and where the answer lives

1. **Project description and purpose** — README top, ARCHITECTURE.md.
2. **Smart-contract and technical architecture** — ARCHITECTURE.md,
   THREAT_MODEL.md dataflow diagram, [SCOPE.md](./SCOPE.md) (contracts,
   LOC, tests, mainnet addresses, privileged roles, focus areas).
3. **Development status and repositories** — github.com/kebkoether/ufama
   (Apache-2.0), DEPLOYMENTS.md, mainnet addresses in SCOPE.md.
4. **Previous security practices or audits** — no external audit.
   SCANS.md, REMEDIATION.md, THREAT_MODEL.md, CI (tests + clippy +
   cargo audit on every PR), SECURITY.md disclosure policy,
   [PRE-AUDIT.md](./PRE-AUDIT.md) internal adversarial review.
5. **Firm preference** — suggest OtterSec or Veridise (both have
   several Soroban reports in the bank) or Certora if we want formal
   verification later. State one; SDF decides.

## To do before sending

- [x] Re-run Scout on the current tree (2026-11-05, GitHub Actions; the
      August run had produced no real detector output) and triage every
      class in SCANS.md. Almanax: not run (hosted service, no CLI).
- [x] Add the RFQ dataflow and threats to THREAT_MODEL.md (T-RFQ-1..9).
- [x] Land PRE-AUDIT.md fixes (PR #81), redeploy RfqSettle v1.1
      (2026-11-05), tag the commit of record (`audit-2026-11-05`).
- [x] hello@ufama.trade and legal@ufama.trade receive mail (Porkbun
      forwarding, 2026-11-05).
- [ ] Decide the firm preference and that the 5% co-pay is acceptable.

## Draft email (send from hello@ufama.trade)

To: sorobanaudits@stellar.org, cc communityfund@stellar.org
Subject: Audit Bank intake request — ufama (Stellar swap aggregator + RFQ settlement), referred by [name]

> Hi,
>
> [Name], head of ecosystem, suggested I apply to the Audit Bank directly
> rather than through SCF. Could you send the intake form?
>
> ufama (ufama.trade) is a non-custodial swap aggregator on Stellar, live
> on mainnet since August 2026. Contracts (Rust, soroban-sdk 27, about
> 4,600 lines, Apache-2.0, github.com/kebkoether/ufama): a router across
> Aqua, SushiSwap V3 and Curve adapters with a partner fee split; an
> on-chain peer-to-peer order book with SEP-40 oracle pricing (Reflector,
> RedStone); a TWAP execution contract; a fee vault; and an RFQ settlement
> contract where makers pre-sign Soroban auth entries and the taker
> settles atomically inside an on-chain NAV band, used to deliver
> tokenized treasuries (Etherfuse stablebonds) at NAV. Priority category:
> financial protocol.
>
> Readiness package already in the repo: STRIDE threat model with
> dataflow diagram, Scout and cargo-audit scans with a remediation plan,
> 75 unit tests plus cross-contract integration tests, CI gating, an
> audit scope document with privileged roles and focus areas, and an
> internal adversarial review. I am an individual operator (KYC as an
> individual), can be responsive for the full engagement, and can cover
> the 5% co-pay. Firm preference: [OtterSec / Veridise].
>
> Thanks,
> Klint
