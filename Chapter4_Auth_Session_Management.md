# 4.2 System Implementation (continued)

*DRAFTING NOTE: This subsection follows 4.2.3 (Repository and Version Control). It documents
authentication, session handling, and role-based access control. The same numbering caveat
given in 4.2.1 and 4.2.2 applies: if the group renumbers 4.2 as 4.3, this becomes 4.3.4.*

*Figure numbers continue the running sequence described in Note 4. Figure 4.1.35 is the last
assigned in the repository section, so the figure below takes 4.1.36.*

---

## 4.2.4 Authentication and Session Management

Access to the Decision-Intelligence dashboard is restricted to authenticated
operators, and the operational modules visible to each depend on the role that
operator holds. This subsection documents how a session is established, where it
is held, how it is renewed before it lapses, and where authorization is decided.
It also records six defects found when the implementation was examined against
these requirements, because several of them had the property that the interface
appeared to enforce a restriction it was not in fact enforcing.

### 4.2.4.1 Identity Provider and Token Issuance

Authentication is delegated to Supabase, which issues a signed JSON Web Token on
a successful email-and-password exchange. The proponents did not implement
password storage, hashing, or reset flows; delegating them removes the most
error-prone part of an authentication system from the project's own code.

A successful sign-in returns two tokens. The **access token** is the short-lived
credential presented on each request to the application server, and is valid for
3,600 seconds. The **refresh token** is longer-lived and is used only to obtain a
new access token. The division is what allows a session to outlast the access
token without the operator signing in again, and it is the mechanism behind
Section 4.2.4.4.

The one-hour lifetime is the consequential figure: an operator monitoring the
corridor through a shift will cross it several times, so the renewal path in
Section 4.2.4.4 is exercised in ordinary use rather than only at the edges.

### 4.2.4.2 Session Storage

The browser client is configured to persist the session and to renew it
automatically. Persistence places the token pair in the browser's local storage
for the application's origin, so that a reload or a reopened window resumes the
session rather than returning the operator to the sign-in screen.

Local storage is readable by any script running on the same origin, which makes
it unsuitable for a credential in an application that embeds third-party script.
The dashboard embeds none: its dependencies are compiled into its own bundle.
The proponents record the trade-off rather than claiming it does not exist — an
HTTP-only cookie is not readable by script and would be the stronger choice, but
it requires a server to set it, and Section 4.2.2.4 explains why this application
has none.

### 4.2.4.3 Role Model

Three roles are defined, carried in the Supabase user record and read from the
token on each request.

**Table 4.2.9** *Roles and the Modules They May Reach*

| Role | May reach | May not reach |
| --- | --- | --- |
| Data Analyst | All modules | — |
| TCC Operator | Traffic, Incidents, Live Map, Maintenance, Mobile, Scenario Sandbox | Environmental Impact, Data Management, Audit Log |
| Incident Operator | Traffic, Incidents, Live Map, Maintenance, Mobile | Environmental Impact, Scenario Sandbox, Data Management, Audit Log |

A session whose record carries no role is treated as an Incident Operator, the
least privileged of the three. This is a correction: the implementation
previously defaulted to Data Analyst, the most privileged, so an incomplete user
record silently received administrative navigation.

### 4.2.4.4 Session Renewal

Renewal happens at two levels, and both are needed.

The browser client renews the access token on its own schedule before it
expires, which covers an operator reading a dashboard for longer than one token
lifetime. That alone does not cover a request that is already in flight when a
token lapses, nor one made after a laptop resumes from sleep with a token that
expired while it was suspended.

The second level handles those. All authenticated calls to the application
server pass through a single module which attaches the current access token,
and, if the server answers 401, requests a new token once and replays the
original request. The operator observes nothing. Where the refresh itself fails —
the refresh token having been revoked or expired — the module raises an
application event and the interface returns the operator to the sign-in screen,
rather than leaving them on a dashboard whose panels have quietly stopped
filling.

**Figure 4.1.36** *Session Lifecycle and Silent Renewal*

```
  Operator                Dashboard                 Application Server      Supabase
     |                        |                              |                  |
     |---- credentials ------>|                              |                  |
     |                        |------------- sign in ---------------------->    |
     |                        |<-------- access + refresh token ------------    |
     |                        | store session                |                  |
     |<--- dashboard ---------|                              |                  |
     |                        |                              |                  |
     |--- opens a module ---->|                              |                  |
     |                        |--- request + access token -->|                  |
     |                        |                              |--- verify ------>|
     |                        |                              |<--- identity ----|
     |                        |<--------- 200 data ----------|                  |
     |                        |                              |                  |
     |                 ... access token expires ...           |                  |
     |                        |                              |                  |
     |--- opens a module ---->|                              |                  |
     |                        |--- request + stale token --->|                  |
     |                        |<--- 401 token_expired -------|                  |
     |                        |------- refresh token ----------------------->   |
     |                        |<-------- new access token ------------------    |
     |                        |--- SAME request, new token ->|                  |
     |                        |<--------- 200 data ----------|                  |
     |<--- data, no prompt ---|                              |                  |
     |                        |                              |                  |
     |                 ... refresh token also invalid ...     |                  |
     |                        |------- refresh token ----------------------->   |
     |                        |<----------- refused ------------------------    |
     |<-- returned to sign-in-|                              |                  |
```

### 4.2.4.5 Where Authorization Is Decided

Authorization is enforced on the application server. Each protected route
verifies the token, resolves the role, and compares it against the roles the
route admits.

The dashboard also restricts navigation: it hides modules a role may not use and
redirects an operator who reaches such a route directly. This is an interface
convenience and **not** a security control, for a reason specific to this
system's architecture. The dashboard is a static export (Section 4.2.2.4), so no
server stands between the operator and the page; every guard it applies runs in
the operator's own browser, where it can be bypassed. A reader should take the
server-side check as the boundary and the client-side guard as the means of not
presenting a door that will not open.

The two share one rule set rather than two copies of it. The navigation filter
and the route guard previously restated the same role-to-route list separately,
which permitted the two to disagree — a hidden link and a reachable route is
protection in appearance only.

The server distinguishes two refusals, which the client depends on:

**Table 4.2.10** *Refusal Semantics*

| Condition | Status | Code | Client behaviour |
| --- | --- | --- | --- |
| No token presented | 401 | `token_missing` | Treat as signed out |
| Token expired | 401 | `token_expired` | Refresh once, replay request |
| Token invalid | 401 | `token_invalid` | Refresh once, replay request |
| Role not permitted | 403 | `role_denied` | Stop; do not retry |
| Provider not configured | 503 | `auth_unconfigured` | Stop; server fault |

Both refusals previously returned 403, which made an expired token
indistinguishable from a forbidden role. A client cannot implement silent
renewal against that, because it has no way to know whether retrying is
meaningful; separating them is what makes Section 4.2.4.4 possible.

### 4.2.4.6 Defects Identified and Corrected

Examining the implementation against the requirements above revealed six
defects. They are reported because each produced an appearance of enforcement
that did not correspond to an actual one, which is the class of fault least
likely to be noticed in use.

**Table 4.2.11** *Access Control Defects and Their Correction*

| # | Defect | Consequence | Correction |
| --- | --- | --- | --- |
| 1 | The dashboard tested for a role but never for a session, and the role defaulted to Data Analyst | A visitor who had not signed in reached the dashboard and was presented the full administrative navigation, Data Management and Audit Log included | A session is resolved before the interface renders; absent one, the operator is returned to sign-in. The default role is now the least privileged |
| 2 | The role guard ran as an effect, after first paint | An operator who opened a forbidden module directly saw its contents render before the redirect | The shell renders nothing until the session and role are known, and a forbidden module is never constructed |
| 3 | The dashboard never sent an authorization header | Every protected endpoint was unreachable from the product; the interface appeared to work only because each page read the public routes mounted ahead of the middleware | A single module attaches the token to all authenticated calls |
| 4 | The file-upload and model-training endpoints carried no authentication | Either could be invoked without a credential, and neither is reversible from the dashboard | Both now require the Data Analyst role |
| 5 | The response cache was mounted ahead of the authorization middleware and keyed on URL alone | A protected response, once cached for an authorised operator, was served from the cache to any later caller without a token | Protected paths bypass the cache, and no response to a request bearing an authorization header is stored |
| 6 | The identity provider's URL and key were hardcoded as fallbacks in both applications | A deployment configured with neither still started and authenticated against the development project, with no indication that it had | Both are read from configuration only, and a server that cannot verify tokens refuses protected routes rather than guessing |

Defect 5 is the one the proponents consider most instructive. The authorization
middleware was correct, and reviewing it in isolation would not have revealed
anything: the fault lay in a caching layer that answered before the middleware
ran, so the protected route's own code was never reached. It is a reminder that
an access control is only as strong as the order of the layers in front of it.

Defect 6 had a second consequence found during testing. The application server's
configuration file contained the key name with an empty value, so the server had
been relying entirely on the hardcoded fallback. Removing the fallback caused
every protected route to refuse service — correctly, and visibly — which is how
the empty value was discovered.

### 4.2.4.7 Verification

**Table 4.2.12** *Access Control Test Results*

Testing used three accounts provisioned for the purpose, one per role in Table
4.2.9.

| # | Scenario | Expected | Observed |
| --- | --- | --- | --- |
| 1 | Sign-in, valid credentials | Access and refresh tokens issued | 200; both issued, access token valid 3,600 s, role present |
| 2 | Protected endpoint, valid token, permitted role | 200, served | 200, served |
| 3 | Sign-in, unknown account | Refused | 400 `invalid_credentials` |
| 4 | Sign-in, wrong password | Refused | 400 `invalid_credentials` |
| 5 | Protected endpoint, no token | 401, refused | 401 `token_missing` |
| 6 | Protected endpoint, malformed token | 401, refused | 401 `token_invalid` |
| 7 | Upload endpoint, no token | 401, refused | 401 `token_missing` |
| 8 | Protected endpoint, valid token, **wrong role** | 403, refused, not retried | 403 `role_denied` |
| 9 | Refused request → refresh → replay | New token obtained, request succeeds | 401 → refresh 200 → replay 200 |
| 10 | Public analytics endpoint | 200, served | 200 |
| 11 | Public endpoint, repeated | Served from cache | 200, `X-Cache: HIT` |
| 12 | Protected endpoint, repeated | Never served from cache | No cache header present |

Scenarios 3 and 4 return an identical message. This is deliberate on the
provider's part and desirable: a response distinguishing "no such account" from
"wrong password" allows an attacker to establish which addresses are registered.

Scenario 8 is the one that justifies the distinction drawn in Table 4.2.10. The
Incident Operator presented a valid, current token and was refused with 403
rather than 401, so a client implementing Section 4.2.4.4 does not attempt a
renewal that could not have changed the outcome.

Scenario 9 is the renewal path end to end: a refused request, a token obtained
with the refresh token, and the original request replayed successfully, with no
re-authentication by the operator. One qualification is owed. The refusal was
induced by presenting a tampered token rather than by waiting out the one-hour
lifetime, so the observed code was `token_invalid` rather than `token_expired`.
Both are 401 and both take the same branch, so the path exercised is the one a
genuine expiry would take; what the test does not independently establish is the
provider's expiry timing, which is the provider's behaviour rather than this
system's.

### 4.2.4.8 Limitations

Three limitations are recorded.

Route guarding in the dashboard is advisory, for the architectural reason given
in Section 4.2.4.5. The server-side check is the control.

The session is held in browser local storage rather than an HTTP-only cookie,
for the reason given in Section 4.2.4.2.

One identity project serves all environments, consistent with the single
warehouse described in Section 4.2.2.1. An account created for testing is
therefore an account that exists in the environment the panel will see.

---

## Addition to Notes for the Group

*Proposed as item 9, following item 8 in the repository section.*

9. Three accounts were provisioned to produce Table 4.2.12, one per role, using
   addresses on a `.test` domain. They exist in the same identity project the
   panel will see, for the reason given in Section 4.2.4.8. The group should
   decide whether to keep them for the demonstration — they are what makes the
   role restrictions in Table 4.2.9 demonstrable — or remove them before
   submission. If they are kept, the shared password should be changed first.

   Section 4.2.4.6 records six corrected defects. If the group prefers Chapter 4
   to report only the delivered state, the table can be reduced to its
   right-hand column, though the proponents recommend against it, as the defects
   evidence the testing that found them.
