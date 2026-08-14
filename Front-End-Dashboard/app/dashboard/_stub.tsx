interface DashboardStubProps {
  title: string;
  description: string;
}

export default function DashboardStub({ title, description }: DashboardStubProps) {
  return (
    <section className="ds-content">
      <section className="ds-section-block">
        <h2>{title}</h2>
        <article className="ds-overview-card">
          <h3>{description}</h3>
          <div style={{ marginTop: "10px", color: "#5f6f88" }}>
            Ready for backend integration.
          </div>
        </article>
      </section>
    </section>
  );
}
