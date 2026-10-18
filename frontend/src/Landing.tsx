import styles from "./Landing.module.css";

import { Link } from "react-router-dom";

export default function Landing({ startTo = "/sign-in", loading = false }: { startTo?: string; loading?: boolean }) {
  return (
    <main className={styles.page}>
      <section className={styles.frame}>
        <div>
        <h1 className={styles.title}>
          <span>Harvest</span>
          <span>Growth</span>
        </h1>
        {loading ? <p role="status">Loading your session…</p> : <Link className={styles.start} to={startTo}>START</Link>}
        </div>

        {/* swap this div for an <img /> once the mascot is drawn */}
        <div className={styles.mascot} role="img" aria-label="Mascot placeholder" />
      </section>
    </main>
  );
}