# Privacy and compliance

Not legal advice. Facial recognition on employees is regulated in most
jurisdictions and the details differ sharply between them — get advice from
someone qualified where you operate before rolling this out.

What this document can do is tell you precisely what the system stores, so that
conversation starts from facts.

## Data inventory

| Data | Where | Retention | Who can read it |
|---|---|---|---|
| Face embedding (512 floats) | `face_templates` | Until the employee or an admin revokes it | **Nobody.** No API role holds `SELECT`; functions return a score, never a vector |
| Face crop per check-in (112×112 JPEG, ~5 KB) | Storage `punch-photos` | `photo_retention_days`, default 30 | The employee, and managers/admins |
| Punch record (time, outcome, scores) | `punch_events` | Indefinite | The employee, and managers/admins |
| Location at check-in | `punch_events` | Indefinite | The employee, and managers/admins |
| Daily roll-up | `attendance_days` | Indefinite | The employee, and managers/admins |
| Device hash | `profiles`, `punch_events` | Until cleared | Admins |
| Email, name, employee code | `profiles` | Until deleted | The employee; the org for managers/admins |
| Admin actions | `audit_log` | Indefinite | Admins |

### What the embedding is, and is not

It is a 512-dimensional vector produced by a neural network — a one-way
projection. You cannot reconstruct a recognisable photograph from it.

It is *not* anonymous. It identifies a specific person, which makes it biometric
personal data under GDPR Article 9, India's DPDP Act, and Illinois' BIPA.
"It's just numbers" is not a defence anyone has successfully run.

### The device hash

Deliberately not a fingerprint. It is a random UUID minted once, stored in
`localStorage`, and SHA-256 hashed before it leaves the browser. It collects
nothing about the device, does not survive cleared site data, and cannot be
correlated across sites.

## What the system does for you

- **No raw images of faces are stored for recognition.** Only embeddings, and
  optionally a small aligned crop per punch for audit.
- **Employees can delete their own biometric data** — one button on the *My
  face* page, no admin needed.
- **Photos expire automatically** via the nightly `purge_expired_photos()` job.
- **Least privilege by construction.** Employees see only their own records;
  nobody can read raw embeddings; every admin action is logged.
- **Retention is configurable and enforced** rather than aspirational.

## What you still have to do

The system cannot do these for you.

**Get explicit, informed, withdrawable consent** before enrolment. Under the
DPDP Act consent must be specific and as easy to withdraw as to give. Under GDPR
Article 9, consent in an employment context is often considered invalid because
of the power imbalance — you may need a different lawful basis, which is
precisely the kind of question to put to a lawyer.

**Offer a genuine alternative.** An employee who declines facial recognition
needs another way to mark attendance without penalty. In several jurisdictions
this is mandatory, and it is good practice everywhere. A manual-correction path
exists in the admin UI; document it as the alternative.

**Tell people what you collect** — this document is a starting point for that
notice. Cover what is stored, for how long, who sees it, and how to withdraw.

**Do a DPIA** if you are under GDPR. Biometric processing at scale essentially
always triggers the requirement.

**Name a retention period for attendance records** and enforce it. The system
keeps `punch_events` and `attendance_days` indefinitely by default because
payroll and labour law often require multi-year retention — but "indefinitely"
is not a policy. Decide on a number and add a purge job.

**Handle deletion requests fully.** The in-app button clears biometric
templates. A complete erasure request also touches `punch_events`,
`attendance_days`, stored photos, `audit_log` and the `auth.users` row — and may
conflict with statutory payroll retention. Work out that conflict in advance.

**Restrict who is an admin.** Admins can see every employee's stored check-in
photos. That is a surveillance capability; treat the admin list accordingly.

## Regional notes

**India (DPDP Act 2023).** Biometric data is personal data; consent must be
free, specific, informed, unconditional and unambiguous, with a clear withdrawal
path. You must publish contact details for a Data Protection Officer or
equivalent. Notice must be available in English and the Eighth Schedule
languages on request.

**EU/UK (GDPR Art. 9).** Special category data. Needs an Art. 9 condition, not
merely consent — and employment-context consent is frequently challenged as not
freely given. A DPIA is effectively mandatory. Several supervisory authorities
have fined employers specifically for biometric attendance systems where a less
intrusive method would have worked.

**Illinois (BIPA).** Written release required before collection, a published
retention schedule, and statutory damages per violation. BIPA litigation is
active and expensive; do not deploy in Illinois without counsel.

**Texas (CUBI), Washington (HB 1493), Colorado, and a growing list of US
states** have their own biometric statutes with differing consent and notice
requirements.

## Model licensing

The recognition weights are the one component whose terms need checking before
commercial use.

The default is the InsightFace `buffalo_s` recogniser. InsightFace's pre-trained
models are published for **non-commercial research purposes**. The code in this
repository is MIT; the weights are not automatically.

For commercial deployment, either:

- obtain a commercial licence for the weights from their authors;
- train or fine-tune your own ArcFace model — any 112×112, 512-d ONNX export
  drops in, since input and output names are read from the session at runtime;
- or use a permissively licensed alternative and verify its terms yourself.

MediaPipe (Apache-2.0), ONNX Runtime (MIT), pgvector (PostgreSQL licence) and
Next.js (MIT) are all clear for commercial use.

## A note on proportionality

Several regulators have taken the position that biometric attendance is
disproportionate when a card, PIN or app-based check-in would achieve the same
end. Before deploying, have an answer to "why was facial recognition necessary
here?" that does not reduce to "it was convenient". Whether or not a regulator
ever asks, your employees will.
