
import styles from "./Landing.module.css";
import mascot from "./assets/mascot.png";
import { Link } from "react-router-dom";

export default function Landing({
  startTo = "/sign-in",
  loading = false,
}: {
  startTo?: string;
  loading?: boolean;
}) {
  return (
    <main className={styles.page}>
      <section className={styles.frame}>
        <div className={styles.content}>
          <h1 className={styles.title}>
            <span>Harvest</span>
            <span>Growth</span>
          </h1>

          {loading ? (
            <p role="status">Loading your session…</p>
          ) : (
            <Link className={styles.start} to={startTo}>
              GET STARTED
            </Link>
          )}
        </div>

        <div className={styles.mascot}>
          <img
            src={mascot}
            alt="HarvestGrowth mascot"
            className={styles.mascotImage}
          />
        </div>
      </section>
    </main>
  );
}
