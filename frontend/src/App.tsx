
import { useMemo, useState } from "react";
import {
  LayoutDashboard,
  MapPinned,
  Store,
  BarChart3,
  FileText,
  Settings,
  Package,
  Users,
  Heart,
  TrendingUp,
  TrendingDown,
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  Send,
  MessageSquare,
  Leaf,
  Sparkles,
  HelpCircle,
  ArrowRight,
  RotateCcw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type InventoryKey = "kits" | "produce" | "canned" | "dairy" | "hygiene";

type Area = {
  name: string;
  priority: number;
  reason: string;
  color: string;
};

type Contribution = {
  name: string;
  date: string;
  amount: number;
  item: string;
};

const areas: Area[] = [
  {
    name: "South Dallas",
    priority: 0.42,
    reason: "High estimated need",
    color: "#60645A",
  },
  {
    name: "West Oak Cliff",
    priority: 0.33,
    reason: "Limited grocery access",
    color: "#A1B58C",
  },
  {
    name: "East Plano",
    priority: 0.25,
    reason: "Transportation barriers",
    color: "#C3B8A1",
  },
];

const contributions: Contribution[] = [
  { name: "South Dallas Community Pantry", date: "Oct 16", amount: 400, item: "Meal kits" },
  { name: "West Oak Cliff Food Hub", date: "Oct 14", amount: 320, item: "Fresh produce" },
  { name: "East Plano Food Pantry", date: "Oct 11", amount: 280, item: "Canned goods" },
  { name: "Linden Park Mutual Aid", date: "Oct 08", amount: 360, item: "Meal kits" },
];

const initialInventory: Record<InventoryKey, number> = {
  kits: 1240,
  produce: 520,
  canned: 380,
  dairy: 210,
  hygiene: 150,
};

const inventoryFields: {
  key: InventoryKey;
  label: string;
  unit: string;
}[] = [
  { key: "kits", label: "Meal Kits", unit: "kits" },
  { key: "produce", label: "Fresh Produce", unit: "lbs" },
  { key: "canned", label: "Canned Goods", unit: "items" },
  { key: "dairy", label: "Dairy Items", unit: "items" },
  { key: "hygiene", label: "Hygiene Kits", unit: "kits" },
];

const questions = [
  "Why is South Dallas prioritized?",
  "What if we had 300 more kits?",
  "How did recent contributions help?",
];

function Panel({
  title,
  icon: Icon,
  extra,
  children,
  className = "",
}: {
  title: string;
  icon: LucideIcon;
  extra?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`retro-panel ${className}`}>
      <div className="panel-heading">
        <div className="flex items-center gap-2">
          <Icon size={17} />
          <h2>{title}</h2>
        </div>
        {extra}
      </div>
      <div className="panel-content">{children}</div>
    </section>
  );
}

function App() {
  const [draftInventory, setDraftInventory] =
    useState<Record<InventoryKey, number>>(initialInventory);

  const [inventory, setInventory] =
    useState<Record<InventoryKey, number>>(initialInventory);

  const [selectedQuestion, setSelectedQuestion] = useState("");
  const [message, setMessage] = useState("");
  const [answer, setAnswer] = useState("");
  const [showGuide, setShowGuide] = useState(true);
  const [notice, setNotice] = useState("");

  // Demo allocation: percentages are illustrative, not AI results.
  // The largest-remainder method ensures integer allocations
  // add up to the exact number of available meal kits.
  const allocations = useMemo(() => {
    const total = inventory.kits;
    const raw = areas.map((area) => total * area.priority);
    const base = raw.map(Math.floor);
    let remainder = total - base.reduce((sum, n) => sum + n, 0);

    const order = raw
      .map((value, i) => ({ i, fraction: value - base[i] }))
      .sort((a, b) => b.fraction - a.fraction);

    for (const entry of order) {
      if (remainder <= 0) break;
      base[entry.i] += 1;
      remainder -= 1;
    }

    return areas.map((area, i) => ({
      ...area,
      kits: base[i],
    }));
  }, [inventory.kits]);

  const allocatedTotal = allocations.reduce(
    (sum, area) => sum + area.kits,
    0
  );

  const maxAllocation = Math.max(
    1,
    ...allocations.map((area) => area.kits)
  );

  function changeInventory(key: InventoryKey, amount: number) {
    setDraftInventory((previous) => ({
      ...previous,
      [key]: Math.max(0, previous[key] + amount),
    }));
  }

  function updateInventory() {
    setInventory({ ...draftInventory });
    setNotice("Inventory updated. Demo allocations recalculated.");
  }

  function askFoodFit(question: string) {
    if (!question.trim()) return;

    const q = question.toLowerCase();

    if (q.includes("why") || q.includes("priorit")) {
      setAnswer(
        "In this demo, South Dallas has the highest preset priority. The production system will consider income, food insecurity, grocery access, and transportation barriers."
      );
    } else if (q.includes("300") || q.includes("more kits")) {
      setAnswer(
        `Adding 300 kits would increase available meal kits to ${
          inventory.kits + 300
        }. Open the inventory panel to test a new allocation.`
      );
    } else if (q.includes("contribution") || q.includes("impact")) {
      setAnswer(
        "Past contributions are listed below. The impact indicators are simulated estimates, not verified outcomes. Actual distributions would require recorded delivery data."
      );
    } else {
      setAnswer(
        "I can explain priority areas, inventory allocation, and contribution impact. Try one of the suggested questions!"
      );
    }

    setSelectedQuestion(question);
    setMessage("");
  }

  const navigation = [
    { label: "Dashboard", icon: LayoutDashboard, active: true },
    { label: "Planner", icon: MapPinned },
    { label: "Pantries", icon: Store },
    { label: "AI Insights", icon: BarChart3 },
    { label: "Reports", icon: FileText },
    { label: "Settings", icon: Settings },
  ];

  return (
    <div className="foodfit-app">
      <div className="app-frame">

        {/* TOP NAVIGATION */}
        <header className="top-navigation">
          <div className="brand-small">
            <Leaf size={20} />
            <span>HARVEST GROWTH</span>
          </div>

          <nav className="navigation-links" aria-label="Main navigation">
            {navigation.map(({ label, icon: Icon, active }) => (
              <button
                key={label}
                type="button"
                className={`nav-tab ${active ? "active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  if (!active) {
                    setNotice(`${label} page is not built yet.`);
                  }
                }}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="nav-slogan">
            GOOD FOOD
            <br />
            STRONGER COMMUNITIES
          </div>
        </header>

        {/* TITLE BANNER */}
        <div className="dashboard-banner">
          <div>
            <h1>HARVESTGROWTH<span className="brand-dot">.</span></h1>
            <p>Community Food Dashboard</p>
          </div>

          <div className="banner-message">
            NOURISH PEOPLE
            <br />
            STRENGTHEN NEIGHBORS
            <br />
            BRIGHTER TOMORROWS
          </div>

          {/* Optional future background pixel illustration */}
          <div className="banner-art-slot">
            <span>YOUR PIXEL ART HERE</span>
          </div>
        </div>

        {notice && (
          <div className="notice-bar">
            <span>{notice}</span>
            <button onClick={() => setNotice("")} aria-label="Dismiss notification">
              ×
            </button>
          </div>
        )}

        {/* SUMMARY METRICS */}
        <section className="metrics-grid">
          <Metric
            icon={Package}
            label="Available Meal Kits"
            value={inventory.kits.toLocaleString()}
            detail="Current demo inventory"
          />
          <Metric
            icon={Users}
            label="Communities Analyzed"
            value="12"
            detail="Simulated neighborhoods"
          />
          <Metric
            icon={MapPinned}
            label="Priority Areas"
            value="3"
            detail="Illustrative ranking"
          />
          <Metric
            icon={Heart}
            label="Donation Allocation"
            value={allocatedTotal.toLocaleString()}
            detail="Kits assigned in demo"
          />
        </section>

        {/* TOP ROW */}
        <div className="dashboard-grid-top">

          {/* INVENTORY INPUT */}
          <Panel title="01 / Inventory Input" icon={Package}>
            <p className="panel-description">
              Enter the donated food currently available.
            </p>

            <div className="inventory-list">
              {inventoryFields.map(({ key, label, unit }) => (
                <div className="inventory-row" key={key}>
                  <span className="inventory-label">{label}</span>

                  <div className="quantity-controls">
                    <button
                      onClick={() => changeInventory(key, -1)}
                      aria-label={`Remove one ${label}`}
                    >
                      <Minus size={13} />
                    </button>

                    <input
                      type="number"
                      min="0"
                      aria-label={`${label} quantity`}
                      value={draftInventory[key]}
                      onChange={(event) => {
                        const value = Math.max(
                          0,
                          Math.floor(Number(event.target.value) || 0)
                        );
                        setDraftInventory((previous) => ({
                          ...previous,
                          [key]: value,
                        }));
                      }}
                    />

                    <button
                      onClick={() => changeInventory(key, 1)}
                      aria-label={`Add one ${label}`}
                    >
                      <Plus size={13} />
                    </button>
                  </div>

                  <span className="inventory-unit">{unit}</span>
                </div>
              ))}
            </div>

            <button className="primary-button" onClick={updateInventory}>
              <Package size={16} />
              UPDATE INVENTORY
              <ArrowRight size={16} />
            </button>

            <p className="tiny-note">
              Meal-kit recommendations update when inventory is saved.
              Other item types are tracked separately.
            </p>
          </Panel>

          {/* RECOMMENDED AREAS */}
          <Panel
            title="02 / Top 3 Recommended Areas"
            icon={MapPinned}
            extra={<span className="heading-tag">DEMO RANKING</span>}
          >
            <p className="panel-description">
              Illustrative allocations for the three highest-priority areas.
            </p>

            <div className="allocation-chart">
              <div className="chart-bars">
                {allocations.map((area, index) => (
                  <div className="chart-column" key={area.name}>
                    <div className="chart-value">
                      {area.kits.toLocaleString()}
                    </div>

                    <div className="bar-track">
                      <div
                        className="chart-bar"
                        style={{
                          height: `${(area.kits / maxAllocation) * 100}%`,
                          backgroundColor: area.color,
                        }}
                      />
                    </div>

                    <div className="chart-location">
                      {area.name}
                    </div>

                    <div className="chart-caption">
                      {area.reason}
                    </div>

                    <div className="rank-number">
                      {String(index + 1).padStart(2, "0")}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="allocation-footer">
              <div>
                <span className="small-label">TOTAL RECOMMENDED</span>
                <strong>{allocatedTotal.toLocaleString()} kits</strong>
              </div>
              <div>
                <span className="small-label">ALLOCATION METHOD</span>
                <strong>Preset demo priorities</strong>
              </div>
            </div>
          </Panel>

          {/* FITBASKET GUIDE */}
          <Panel
            title="03 / Your Guide"
            icon={Heart}
            extra={
              <button
                className="icon-button"
                onClick={() => setShowGuide(!showGuide)}
                aria-label="Toggle guide"
              >
                {showGuide ? <Minus size={16} /> : <Plus size={16} />}
              </button>
            }
          >
            {showGuide && (
              <div className="guide-content">
                <div className="mascot-row">
                  {/* Replace this block with your PNG later */}
                  <div className="mascot-slot">
                    <span>FitBasket</span>
                    <small>PNG SPRITE</small>
                  </div>

                  <div className="speech-bubble">
                    <strong>HI! I'M FITBASKET!</strong>
                    <p>
                      I'll help you explore community needs,
                      manage donations, and understand the results!
                    </p>
                  </div>
                </div>

                <div className="guide-actions">
                  <button onClick={() =>
                    document.getElementById("impact-section")
                      ?.scrollIntoView({ behavior: "smooth" })
                  }>
                    <TrendingUp size={16} />
                    See community impact
                    <ChevronRight size={15} />
                  </button>

                  <button onClick={() => {
                    setNotice(
                      "Distribution Planner will be connected in a future phase."
                    );
                  }}>
                    <MapPinned size={16} />
                    Plan a distribution
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
            )}
          </Panel>
        </div>

        {/* BOTTOM ROW */}
        <div className="dashboard-grid-bottom">

          {/* CONTRIBUTIONS */}
          <Panel title="04 / Recent Contributions" icon={FileText}>
            <p className="panel-description">
              Example distribution records for the demo.
            </p>

            <div className="contribution-list">
              {contributions.map((contribution) => (
                <div className="contribution-row" key={contribution.name}>
                  <div className="contribution-symbol">
                    <Package size={18} />
                  </div>

                  <div className="contribution-info">
                    <strong>{contribution.name}</strong>
                    <span>{contribution.item} · {contribution.date}</span>
                  </div>

                  <div className="contribution-amount">
                    +{contribution.amount}
                  </div>
                </div>
              ))}
            </div>

            <button
              className="text-action"
              onClick={() => setNotice(
                "Contribution history is currently sample data."
              )}
            >
              VIEW ALL CONTRIBUTIONS <ArrowRight size={15} />
            </button>
          </Panel>

          {/* IMPACT */}
          <div id="impact-section">
            <Panel title="05 / Contribution Impact" icon={BarChart3}>
              <p className="panel-description">
                Illustrative before-and-after community outcomes.
              </p>

              <ImpactRow
                icon={TrendingDown}
                title="Estimated Unmet Demand"
                before={100}
                after={82}
                result="18% lower"
              />

              <ImpactRow
                icon={Leaf}
                title="Food Access Coverage"
                before={56}
                after={78}
                result="+22 points"
              />

              <ImpactRow
                icon={Users}
                title="Distribution Coverage"
                before={40}
                after={68}
                result="+28 points"
              />

              <p className="tiny-note">
                These examples are not verified outcomes.
                Actual impact requires distribution and accessibility data.
              </p>
            </Panel>
          </div>

          {/* CHATBOT */}
          <Panel title="06 / Ask FoodFit" icon={MessageSquare}>
            <div className="chat-container">
              <p className="panel-description">
                Ask questions about community priorities,
                inventory, and distribution planning.
              </p>

              <div className="suggested-questions">
                {questions.map((question) => (
                  <button
                    key={question}
                    onClick={() => askFoodFit(question)}
                  >
                    <Sparkles size={14} />
                    {question}
                  </button>
                ))}
              </div>

              {answer && (
                <div className="chat-answer" aria-live="polite">
                  <span className="small-label">
                    FOODFIT RESPONSE
                  </span>
                  <strong>{selectedQuestion}</strong>
                  <p>{answer}</p>
                </div>
              )}

              <form
                className="chat-input"
                onSubmit={(event) => {
                  event.preventDefault();
                  askFoodFit(message);
                }}
              >
                <input
                  value={message}
                  onChange={(event) =>
                    setMessage(event.target.value)
                  }
                  placeholder="Ask FoodFit a question..."
                  aria-label="Ask FoodFit a question"
                />

                <button type="submit" aria-label="Send message">
                  <Send size={17} />
                </button>
              </form>

              <p className="tiny-note">
                Demo assistant · Not yet connected to an AI model.
              </p>
            </div>
          </Panel>
        </div>

        {/* FOOTER */}
        <footer className="page-footer">
          <span>FOODFIT · IBM Z DATATHON 2026</span>
          <span>
            <HelpCircle size={13} />
            SIMULATED DATA · PROTOTYPE
          </span>
        </footer>
      </div>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="metric-card">
      <div className="metric-icon">
        <Icon size={24} />
      </div>
      <div>
        <span className="metric-label">{label}</span>
        <strong className="metric-value">{value}</strong>
        <span className="metric-detail">{detail}</span>
      </div>
    </article>
  );
}

function ImpactRow({
  icon: Icon,
  title,
  before,
  after,
  result,
}: {
  icon: LucideIcon;
  title: string;
  before: number;
  after: number;
  result: string;
}) {
  return (
    <div className="impact-row">
      <div className="impact-icon">
        <Icon size={19} />
      </div>

      <div className="impact-data">
        <strong>{title}</strong>

        <div className="impact-bar-row">
          <span>BEFORE</span>
          <div className="impact-track">
            <div
              className="impact-fill before"
              style={{ width: `${before}%` }}
            />
          </div>
        </div>

        <div className="impact-bar-row">
          <span>AFTER</span>
          <div className="impact-track">
            <div
              className="impact-fill after"
              style={{ width: `${after}%` }}
            />
          </div>
        </div>
      </div>

      <div className="impact-result">
        {result}
      </div>
    </div>
  );
}

export default App;
