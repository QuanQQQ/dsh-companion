# DSH Companion

DSH Companion governs explicit, Task-scoped permission for a paired macOS Device to expose a devbox loopback service on the same loopback port. It separates declared services, forwarding authority, and observed runtime state so recovery cannot silently broaden access.

## Trust and Devices

**Device**:
A stable identity for one paired macOS installation. Connectivity is an observation about a Device, not part of its identity or trust.
_Avoid_: Client, agent, machine session

**Pairing**:
Revocable trust between the DSH Host and a Device. Pairing persists independently of whether the Device is online.
_Avoid_: Login, connection

**Enrollment Request**:
A bounded, expiring request from a Mac to become paired. Its visible verification code lets a logged-in human identify the requesting terminal; its separate secret poll capability delivers an approved credential once. The request alone grants no trust or Lease.

**Unified Launch**:
An explicit human invocation that fetches the intended Host's current program, verifies the stored pairing, and replaces the owned local process. A changed authority or rejected credential requires explicit new enrollment; it cannot inherit old forwarding authority.

**Local SSH Configuration**:
The human-selected local connection recipe, interpreted exclusively by system OpenSSH. Its commands are trusted local code, not Host-issued forwarding authority. Companion owns an isolated SSH connection and adds only the authorized Forward Instance; connection authentication does not itself grant a listener.

**Preferred Device**:
A presentation default used to preselect a Device for a human action. It grants no authority and never causes migration or failover.
_Avoid_: Primary Device, active Device

**Authority Epoch**:
The identity of one Host authority lineage. A Device rejects commands from an authority lineage that is not bound to its pairing.
_Avoid_: Server version

**Connection Session**:
One authenticated online relationship between a Host and a Device. Commands from an older Connection Session are stale even when their Lease generation matches.
_Avoid_: Pairing, Device

## Task Services and Forwarding

**Task Service**:
A Task-owned declaration that a service is expected on a devbox loopback port. Its existence is not permission to expose that port on any Device.
_Avoid_: Tunnel, Forward

**Task Service Registration**:
Creation or refresh of a Task Service declaration. Registration never opens a Forward Lease.
_Avoid_: Forwarding, authorization

**Task Service Unregistration**:
Retirement of one declaration and atomic revocation of all its Device Leases. Close records and observations remain queryable; no devbox application process is stopped. Registering the same port again creates a fresh declaration without inheriting authorization.
_Avoid_: Device unpairing, process shutdown

**Forward Close**:
Revocation of one Lease while retaining its service declaration and other Device Leases. Listener shutdown is confirmed only by a matching-generation observation reporting closed, SSH exited, and listener missing; Desired Closed alone is not confirmation.
_Avoid_: Service deletion, synchronous shutdown proof

**Forward Lease**:
A time-bounded authorization for one Task Service on one Device. A Lease fixes both ends to loopback and requires the Device port to equal the Task Service port.
_Avoid_: Tunnel, connection

**Forward Instance**:
The Device-side runtime realization of a Forward Lease. An Instance may be absent or unhealthy while its Lease remains valid.
_Avoid_: Lease, Task Service

**Desired State**:
The Host-authoritative intent for a Forward Lease to be open or closed. Desired State can change only through an authorized Host action or a safety boundary such as expiry, revocation, or Task archival.
_Avoid_: Runtime status

**Observed State**:
The latest accepted report of a Forward Instance. Observed State cannot create, renew, migrate, or reopen a Forward Lease.
_Avoid_: Desired State

**Forward Generation**:
A monotonically increasing fence for changes to one Forward Lease. An observation or operation from an older generation has no authority over a newer generation.
_Avoid_: Retry count, version

**Forward Operation**:
An idempotent Host instruction to converge one Forward Lease generation. Reusing its identity with different meaning is invalid.
_Avoid_: Request, command attempt

**Close Tombstone**:
A retained closed Desired State that proves a Forward Instance must not exist. It remains relevant while a Device is offline so stale open work cannot resurrect after reconnect.
_Avoid_: Deleted Lease

## Health and Recovery

**Reconciliation**:
Comparison of Desired State with Observed State followed by bounded convergence work. Reconciliation cannot grant permission, extend expiry, choose another Device, or change a port.
_Avoid_: Failover, authorization

**Health Observation**:
The combined evidence for Device connectivity, SSH child state, local listener ownership, and an optional remote TCP probe. No single layer stands for the others.
_Avoid_: Online status

**Recovery Classification**:
The decision that a failure is either transient and eligible for bounded retry, or needs attention and requires a human or new authority. Port conflict, authentication failure, Host Key failure, revocation, policy refusal, Task archival, and Lease expiry need attention.
_Avoid_: Error severity

**Lease Expiry**:
The end of Forward Lease authority at its Host-defined deadline. Expiry closes Desired State even while the Device is offline and cannot be extended by reconciliation.
_Avoid_: Idle timeout
