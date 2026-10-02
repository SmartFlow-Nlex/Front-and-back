# Repository and branching

How this project is tracked in Git. Written from what the repository actually
does, so that a new contributor can follow it and a reader of the manuscript can
verify it.

## Remotes

Two, and the distinction matters.

| Remote | Purpose |
| --- | --- |
| `origin` | Day-to-day work. Every contributor pushes their own feature branches here. |
| `nlex-main` | Integration and handoff. Holds only the two branches below. |

`nlex-main` carries exactly two long-lived branches:

| Branch | Holds |
| --- | --- |
| `Main-Dashboard` | The web application — Next.js dashboard and Express backend. The repository's default branch. |
| `Main-Mobile` | The React Native mobile application, which is a separate app with its own build. |

The mobile application is kept on its own branch rather than in a subdirectory
because it has an independent toolchain and release cycle, and shares nothing
with the dashboard but the backend API contract (`/api/mobile-config`).

## Feature branches

Named `<Area>-<Owner>`, so that the owner of any branch is readable from its
name without consulting the log. Examples from the current repository:

| Branch | Owner | Area |
| --- | --- | --- |
| `Incident-Predictive-Jertz5` | Jertz | Incident predictive analytics |
| `Improved-simulator-ysa` | Ysa | Agent-based simulation sandbox |
| `Fixed-Map-Kia` | Kiarra | Live corridor map |
| `Incident-Prescriptive-Jertz` | Jertz | Incident prescriptive panels |

A numeric suffix (`Jertz2`, `Jertz5`) marks a successive attempt at the same
area rather than a different feature, which keeps the history of an iteration
together instead of scattering it.

## Integration

One person integrates, which is deliberate: with four contributors working
across the same dashboard, a shared merge queue produced conflicts faster than
they could be resolved.

1. A contributor finishes work on their feature branch and pushes to `origin`.
2. The integrator creates a **backup branch** at the current integration head,
   named `backup-before-<area>-merge`, before touching anything.
3. The feature branch is merged into the integration branch and the result is
   run locally — the dashboard is opened and the affected pages are exercised.
4. The integration branch is pushed to `nlex-main/Main-Dashboard`.

The backup branches are not clutter; they are the rollback. The repository
currently holds six of them, one per significant merge:

```
backup-before-traffic-merge
backup-before-incident-merge
backup-before-jertz2-merge
backup-before-jertz3-merge
backup-before-prescriptive-merge
backup-before-hans-traffic-emissions-merge
```

If a merge is later found to have broken something, the state before it is a
`git checkout` away rather than a revert of a merge commit with several parents.

Versioned integration branches (`Ver1-Merged-BE-FE` through
`Ver7-Merged-BE-FE-Kia`, eight in all) mark the successive full-stack merges of the backend
and frontend, and are retained as checkpoints.

## Secrets and .gitignore

The rule is asymmetric, and the asymmetry is intentional.

| File | Tracked | Why |
| --- | --- | --- |
| `Back-End/.env` | **Never** | Database credentials, Redis tokens, API keys. Ignored by `.gitignore`. |
| `Back-End/.env.example` | Yes | Key names and comments, no values. Negated in `.gitignore` with `!Back-End/.env.example`. |
| `Front-End-Dashboard/.env` | **Yes** | Holds only `NEXT_PUBLIC_*` values, which Next.js compiles into the browser bundle. They are public the moment the site ships, so tracking them costs nothing and keeps builds reproducible. |
| `Front-End-Dashboard/.env.example` | Yes | Documents the same keys for a fresh checkout. |

Nothing secret can live in a `NEXT_PUBLIC_*` variable. The Mapbox token in the
frontend `.env` is public by design and is restricted by URL in the Mapbox
console rather than by secrecy.

Verify the rule holds at any time with:

```
git ls-files | grep -i '\.env'
```

which should list only `.env.example` files and `Front-End-Dashboard/.env`.

## Not yet in place

**Branch protection is not configured.** Direct pushes to `Main-Dashboard` are
currently possible and Pull Requests are not required. The integration
discipline above is followed by convention rather than enforced by the
repository, which is a weaker guarantee and is recorded here as such.

To close it, on the `nlex-main` repository:

- [ ] Protect `Main-Dashboard`: block direct pushes, require a Pull Request
- [ ] Require at least one approving review before merge
- [ ] Apply the same to `Main-Mobile`
