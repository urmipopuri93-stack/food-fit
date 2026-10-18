import { Link } from "react-router-dom";

// Shown for unknown URLs instead of a blank page.
export default function NotFound() {
  return (
    <main style={{ maxWidth: 560, margin: "15vh auto", padding: "0 16px", color: "#2b3a2b" }}>
      <h1>Page not found</h1>
      <p>There is no page at this address.</p>
      <p>
        <Link to="/">Home</Link> · <Link to="/dashboard">Dashboard</Link> · <Link to="/heatmap">Food-access map</Link>
      </p>
    </main>
  );
}
