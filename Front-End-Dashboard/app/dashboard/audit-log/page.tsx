export default function AuditLogPage() {
  return (
    <section className="ds-content ds-long">
      <h1 className="tab-title">Audit Log</h1>
      <p className="muted" style={{ marginBottom: 14 }}>Track all system activities and user actions</p>
      <div className="tab-stat-grid compact">
        <article className="tab-stat-card"><h3>Total Events</h3><div className="value">86</div></article>
        <article className="tab-stat-card"><h3>Auth Events</h3><div className="value">5</div></article>
        <article className="tab-stat-card"><h3>Critical Events</h3><div className="value">0</div></article>
        <article className="tab-stat-card"><h3>Filtered Results</h3><div className="value">86</div></article>
      </div>
      <section className="table-card">
        <div className="table-toolbar">
          <input placeholder="Search logs..." />
          <select><option>All Categories</option></select>
          <select><option>All Severities</option></select>
          <select><option>All Time</option></select>
          <button className="btn-primary">Export</button>
          <button className="btn-danger">Clear</button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>TIMESTAMP</th>
                <th>USER</th>
                <th>CATEGORY</th>
                <th>ACTION</th>
                <th>DETAILS</th>
                <th>SEVERITY</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  <td>Apr 29, 2026, 07:3{i}:23 PM</td>
                  <td>admin</td>
                  <td><span className="badge">navigation</span></td>
                  <td>Page Navigation</td>
                  <td>Navigated to Audit Log</td>
                  <td><span className="pill blue">Info</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
