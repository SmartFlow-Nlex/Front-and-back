# 4.2 System Implementation (continued)

*DRAFTING NOTE: These two subsections follow 4.2.1 (Global UI/UX Design System) and document
the deployment and source-control arrangements under which the system was built. If the group
adopts the alternative numbering discussed in the drafting note to 4.2.1, these become 4.3.2
and 4.3.3 and the figure numbers shift with them.*

*Figure numbers continue the running sequence described in Note 4. Figure 4.1.33 is the last
assigned in the UI/UX section, so the two figures below take 4.1.34 and 4.1.35.*

---

## 4.2.2 Environment Configuration

The system is deployed as two independently hosted services — a statically
exported Next.js dashboard and an Express application server — which draw on a
shared PostgreSQL/PostGIS warehouse and five external providers. Because no
credential may be committed to the repository and because the two services are
configured by different mechanisms, the proponents specified the configuration
surface explicitly rather than allowing it to accumulate as each provider was
introduced.

### 4.2.2.1 Delivery Stages

The dashboard is delivered as an **installed desktop application** rather than as
a published website. It is packaged with Electron, which loads the static export
described in Section 4.2.2.4 and presents it in its own window. The proponents
adopted this form because the system is an operations console for the traffic
control centre: its users are a known set of operators at known workstations, and
an installed application neither requires a public address nor exposes the
corridor data to one.

Three stages follow from that. Table 4.2.4 states what each comprises.

**Table 4.2.4** *Delivery Stages and Their Hosts*

| Stage | Dashboard | Application Server | Warehouse |
| --- | --- | --- | --- |
| Development | Local development server, port 3002 | Local watch process, port 4000 | AWS RDS |
| Desktop, unpackaged | Static export served locally and loaded by the desktop shell | Local application server | AWS RDS |
| Desktop, installed | Windows installer produced by the packaging step | A host reachable from the operator workstation | AWS RDS |

A single warehouse instance serves all three stages. The proponents adopted this
arrangement because the system draws on one corridor dataset assembled by the
extract-transform-load pipeline described in Section 4.1.1, and a duplicated
instance would diverge from it as the pipeline continued to run against only one.
The limitation this imposes is recorded rather than resolved: there is no stage
isolated from operational data, and none is therefore suitable for exercising
operations that write to or delete from the warehouse.

### 4.2.2.2 Configuration Parameters

Application-server parameters are supplied through an environment file in
development and through the environment of the host that runs the application
server in a desktop deployment. Table 4.2.5 states each parameter and the value class it carries
per stage.

**Table 4.2.5** *Application Server Configuration Parameters*

| Parameter | Development | Desktop deployment | Function |
| --- | --- | --- | --- |
| `PORT` | 4000 | Assigned by the host | The hosting platform injects the port at container start; a fixed value renders the service unreachable |
| `NODE_ENV` | Unset | `production` | Selects production behaviour in the server framework |
| `FRONTEND_ORIGIN` | Local dashboard origin | Deployed dashboard origin for that stage | Cross-origin request allow-list |
| `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD` | Warehouse instance | Same instance | Assembled into a connection string at startup, with the password percent-encoded |
| `PG_SSL_MODE` | `relaxed` | `relaxed` | Transport security mode; see Section 4.2.2.3 |
| `REDIS_REST_URL`, `REDIS_REST_TOKEN` | Cache provider | Same provider | Live incident feed cache |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Auth provider | Same provider | Operator authentication and audit logging |
| `CLIMATIQ_API_KEY` | Emissions provider | Same provider | Emission factor lookup, Section 4.1.5 |
| `GLM_API_KEY`, `GLM_MODEL`, `GLM_BASE_URL` | Language model provider | Same provider | Narrative generation layer, Section 4.1.7 |

Dashboard parameters number two: the application server's base address and the
geospatial rendering token. Both are declared under the framework's public prefix
and are therefore compiled into the browser bundle.

### 4.2.2.3 Transport Security to the Warehouse

The managed warehouse requires that all connections be encrypted, and refuses
unencrypted ones. It presents a certificate issued by a regional authority that
the application runtime does not carry in its default trust store, so full
certificate-chain verification fails even though the connection is encrypted.

Two resolutions are available. The runtime may be supplied with the provider's
certificate authority bundle, after which full verification succeeds; or
verification may be relaxed while encryption is retained. The delivered system
takes the second, selected by a configuration parameter that also admits the
first. The proponents record the distinction because the two are frequently
conflated: the connection is encrypted in transit under both settings, and what
the relaxed setting forgoes is verification of the server's identity, which
leaves the connection exposed to interception by an intermediary rather than to
passive observation.

### 4.2.2.4 The Consequence of Static Export

The dashboard is produced by static export, which resolves every public
configuration value at build time and writes it into the emitted JavaScript. No
server process reads configuration at request time, because none exists.

Two operational consequences follow, both of which the proponents encountered
before the mechanism was understood. A value altered after a build has no effect
until the application is rebuilt, there being nothing running to re-read it. And
the address of the application server is frozen into the installer, so every
machine that receives it will ask for that same address.

The failure mode is not self-announcing. A build carrying the development address
directs each workstation to port 4000 on itself, which succeeds only on the
machine that produced the build and presents everywhere else as an unavailable
application server rather than as a configuration error. The build order in
Table 4.2.6 exists to prevent it.

**Table 4.2.6** *Build Sequence*

| Step | Action |
| --- | --- |
| 1 | Start the application server where the installed application will reach it, and record that address |
| 2 | Add the dashboard's origin to the application server's cross-origin allow-list |
| 3 | Set the application server address in the dashboard's build configuration |
| 4 | Build and package the desktop application |
| 5 | Install it on a machine other than the one that built it and open a data-bearing page |

Steps 3 and 4 are ordered rather than interchangeable, and step 5 is performed on
a second machine deliberately: the failure described above is invisible on the
build machine.

### 4.2.2.5 Outstanding Work in the Packaged Build

Two items stand between the current state and a distributable installer, and are
recorded rather than deferred silently.

The unpackaged desktop run serves the exported files over a local HTTP address
that the application server's allow-list already admits, and works. The packaged
application instead loads its pages directly from the file system, and a page
loaded that way presents a null origin on each request. The allow-list does not
admit it, so an installed copy would render its interface and fail every data
call. Serving the exported files locally in the packaged application as well —
one code path for both runs, reusing an origin already configured — is the
proponents' recommended resolution.

The packaging configuration itself is also absent: the project declares the
packaging tool and the command that invokes it, but not the application
identifier, file manifest, or icon that the tool requires to produce a correct
installer.

Neither item affects the system as demonstrated from a development or unpackaged
desktop run, which is how the results in Section 4.1 were produced.

### 4.2.2.6 Secret Handling

No credential value appears in the repository. Two template files — one per
service — declare the parameter names with commentary and no values, so that a
new working copy can be configured without recourse to a team member's machine.

The treatment of the two services' environment files is deliberately asymmetric,
and the asymmetry is stated here because it reads as an inconsistency otherwise.
The application server's environment file is never committed: it carries
warehouse credentials, provider tokens, and API keys. The dashboard's environment
file is committed, because it carries only values under the framework's public
prefix, which are compiled into the browser bundle and are therefore disclosed to
every visitor the moment the site is served. Withholding them from the repository
would conceal nothing while making a fresh working copy harder to build.

It follows that no value requiring secrecy can be held in a dashboard parameter.
The geospatial rendering token is public of necessity and is constrained by
origin restriction in the provider's console — a control that operates on where
the token may be used rather than on who holds it, which is the only control
available to a credential shipped to a browser.

*[INSERT SCREENSHOT — the application server configuration, with values masked]*

**Figure 4.1.34** *Application Server Configuration Parameters*

---

## 4.2.3 Repository and Version Control

### 4.2.3.1 Repository Arrangement

The project is tracked in Git across two remote repositories serving distinct
purposes. The first receives day-to-day work: each proponent pushes their own
feature branches to it. The second holds integration and handoff, and carries
exactly two long-lived branches — one for the web application comprising the
dashboard and application server, and one for the mobile application described in
Section 3.13.

The mobile application is held on a separate branch rather than in a
subdirectory of the same tree. It has an independent toolchain and release cycle
and shares nothing with the dashboard except the application programming
interface contract through which it retrieves its configuration.

### 4.2.3.2 Branch Naming and Ownership

Feature branches are named by area and owner, so that the owner of any branch is
readable from its name without consulting the commit log. Table 4.2.7 gives
representative branches from the delivered repository.

**Table 4.2.7** *Feature Branch Naming Convention*

| Branch | Owner | Area |
| --- | --- | --- |
| `Incident-Predictive-Jertz5` | Jertz | Incident predictive analytics |
| `Improved-simulator-ysa` | Ysa | Agent-based simulation sandbox |
| `Fixed-Map-Kia` | Kiarra | Live corridor map |
| `Incident-Prescriptive-Jertz` | Jertz | Incident prescriptive panels |

A numeric suffix denotes a successive attempt at the same area rather than a
different feature, which keeps the history of one iteration together instead of
distributing it across unrelated names.

### 4.2.3.3 Integration Procedure

Integration is performed by one proponent rather than by each in turn. With four
contributors working across a shared dashboard, concurrent merging produced
conflicts faster than they were resolved, and the arrangement was adopted in
response to that.

Before any feature branch is merged, a branch is created at the current
integration head and named for the merge it precedes. The merge is then
performed, the result is run locally, and the affected pages are exercised before
the integration branch is published.

These preceding branches constitute the rollback mechanism. Six were created
over the course of development, one per significant merge. Where a merge is later
found to have introduced a regression, the state before it is recoverable by
checkout, rather than by reverting a merge commit with multiple parents — an
operation that is error-prone and that complicates any subsequent merge of the
same branch. Eight further branches record successive full-stack integrations of
the application server and dashboard and are retained as checkpoints.

**Table 4.2.8** *Version Control Practices and Their Status*

| Practice | Status |
| --- | --- |
| Feature branches named by area and owner | In use |
| Single-integrator merging | In use |
| Rollback branch created before each integration merge | In use, six recorded |
| Credentials excluded by ignore rules, with template files retained | In use, verified |
| Branch protection on the integration branches | **Not configured** |
| Pull request and review required before merge | **Not configured** |

*[INSERT SCREENSHOT — repository branch listing showing feature branches and
the rollback branches]*

**Figure 4.1.35** *Repository Branch Structure*

### 4.2.3.4 Limitation in the Version Control Configuration

The final two rows of Table 4.2.8 are reported as not configured rather than
omitted from the table.

Branch protection is not enabled on the integration repository. Direct pushes to
the integration branches remain possible and pull requests are not required
before merging. The integration procedure described in Section 4.2.3.3 is
therefore observed by the proponents' agreement and not enforced by the
repository, which is a materially weaker guarantee: it holds while the convention
is remembered and fails silently when it is not.

The proponents record this as an outstanding item rather than as a completed
practice. Enabling protection on both integration branches, requiring a pull
request, and requiring one approving review would close it, and none of the three
requires any change to the delivered system.

---

## Addition to Notes for the Group

*Proposed as item 8, following item 7 in the UI/UX section.*

8. Section 4.2.3.4 records that branch protection and pull-request review are not
   configured on the integration repository. This is a practice gap rather than a
   defect in the delivered system, and it can be closed before submission by
   changing three repository settings. The group should decide whether to close
   it and revise the section, or to submit it as recorded. The proponents note
   that a limitation stated plainly is defensible in a panel review, whereas a
   practice claimed and not implemented is not.
