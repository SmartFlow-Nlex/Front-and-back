export default function DashboardLoading() {
  return (
    <section className="ds-content">
      <div className="ds-loader-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: '60vh', gap: '16px' }}>
        <div className="ds-spinner" style={{ width: '40px', height: '40px', border: '4px solid var(--brand-primary-light)', borderTopColor: 'var(--brand-primary)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
        <p style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>Loading dashboard data...</p>
        <style dangerouslySetInnerHTML={{__html: `
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}} />
      </div>
    </section>
  );
}
