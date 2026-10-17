import styles from "./Landing.module.css";

export default function Landing() {
  return (
    <main className={styles.page}>
      <section className={styles.frame}>
        <h1 className={styles.title}>
          <span>Harvest</span>
          <span>Growth</span>
        </h1>

        {/* swap this div for an <img /> once the mascot is drawn */}
        <div className={styles.mascot} role="img" aria-label="Mascot placeholder" />
      </section>
    </main>
  );
}