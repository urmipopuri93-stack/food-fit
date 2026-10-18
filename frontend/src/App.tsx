import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { UserButton } from "@clerk/react";
import foodfitDrawing from "../assets/Untitled 10.png";

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
  Plus,
  Minus,
  Send,
  Leaf,
  Sparkles,
  HelpCircle,
  ArrowRight,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import "./dashboard.css";

type InventoryKey = "kits" | "produce" | "canned" | "dairy" | "hygiene";

type Community = {
  GEOID: string;
  County: string;
  location: string;
  TotalPop: number;
  income_score: number;
  transportation_score: number;
  grocery_score: number;
  overall_need_score: number;
  grocery_observed: boolean;
};

type AllocatedArea = Community & {
  name: string;
  reason: string;
  color: string;
  kits: number;
};

// Prototype allocation: rank tracts by estimated barriers, then split kits
// by need score * population. Not a verified measure of food demand.
function rankDonationLocations(communities: Community[], kits: number): AllocatedArea[] {
  const available = Math.max(0, Math.floor(Number(kits) || 0));
  const top = communities
    .filter((c) => Number.isFinite(c.overall_need_score) &&
      Number.isFinite(c.TotalPop) && c.TotalPop > 0)
    .sort((a, b) => b.overall_need_score - a.overall_need_score)
    .slice(0, 3);

  if (top.length === 0) return [];
  const weights = top.map((c) => Math.max(0, c.overall_need_score) * c.TotalPop);
  const sum = weights.reduce((a, b) => a + b, 0);
  const fractional = weights.map((w) => sum > 0 ? (available * w) / sum : available / top.length);
  const assigned = fractional.map(Math.floor);
  let leftover = available - assigned.reduce((a, b) => a + b, 0);
  const order = fractional.map((n, i) => ({ i, remainder: n - assigned[i] }))
    .sort((a, b) => b.remainder - a.remainder);
  for (const { i } of order) {
    if (leftover <= 0) break;
    assigned[i]++;
    leftover--;
  }

  const colors = ["#4a4b40", "#8db05e", "#b7ab8e"];
  return top.map((c, i) => {
    const factors = [
      { label: "Income barriers", value: c.income_score },
      { label: "Transportation barriers", value: c.transportation_score },
      { label: "Grocery-access barriers", value: c.grocery_score },
    ];
    const strongest = factors.sort((a, b) => b.value - a.value)[0];
    return {
      ...c,
      name: c.location || `${c.County} County · Tract ${c.GEOID.slice(-6)}`,
      kits: assigned[i],
      reason: strongest.label,
      color: colors[i],
    };
  });
}

type Contribution = {
  name: string;
  date: string;
  amount: number;
  item: string;
  impactLabel: string;
  before: number;
  after: number;
  result: string;
};

const contributions: Contribution[] = [
  { name: "South Dallas Community Pantry", date: "Oct 16", amount: 400, item: "Meal kits", impactLabel: "Estimated Unmet Demand", before: 100, after: 82, result: "18% lower" },
  { name: "West Oak Cliff Food Hub", date: "Oct 14", amount: 320, item: "Fresh produce", impactLabel: "Food Access Coverage", before: 56, after: 78, result: "+22 points" },
  { name: "East Plano Food Pantry", date: "Oct 11", amount: 280, item: "Canned goods", impactLabel: "Distribution Coverage", before: 40, after: 68, result: "+28 points" },
  { name: "Linden Park Mutual Aid", date: "Oct 08", amount: 360, item: "Meal kits", impactLabel: "Food Access Coverage", before: 48, after: 66, result: "+18 points" },
];

const initialInventory: Record<InventoryKey, number> = {
  kits: 1240,
  produce: 520,
  canned: 380,
  dairy: 210,
  hygiene: 150,
};

const inventoryFields: { key: InventoryKey; label: string; unit: string }[] = [
  { key: "kits", label: "Meal Kits", unit: "kits" },
  { key: "produce", label: "Fresh Produce", unit: "lbs" },
  { key: "canned", label: "Canned Goods", unit: "items" },
  { key: "dairy", label: "Dairy Items", unit: "items" },
];

const questions = [
  "Why is the top area prioritized?",
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

  const [communities, setCommunities] = useState<Community[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetch("/data/texas_dashboard.json", { signal: controller.signal });
        if (!res.ok) throw new Error("Could not load texas_dashboard.json");
        const json: unknown = await res.json();
        if (!Array.isArray(json)) throw new Error("Dashboard data is not an array");
        setCommunities(json as Community[]);
      } catch (error) {
        if (!controller.signal.aborted) {
          setDataError(error instanceof Error ? error.message : "Data loading failed");
        }
      } finally {
        if (!controller.signal.aborted) setDataLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  const [selectedQuestion, setSelectedQuestion] = useState("");
  const [message, setMessage] = useState("");
  const [answer, setAnswer] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [notice, setNotice] = useState("");

  const allocations = useMemo(
    () => rankDonationLocations(communities, inventory.kits),
    [communities, inventory.kits]
  );

  const allocatedTotal = allocations.reduce((sum, area) => sum + area.kits, 0);
  const maxAllocation = Math.max(1, ...allocations.map((area) => area.kits));

  function changeInventory(key: InventoryKey, amount: number) {
    setDraftInventory((previous) => ({
      ...previous,
      [key]: Math.max(0, previous[key] + amount),
    }));
  }

  function updateInventory() {
    setInventory({ ...draftInventory });
    setNotice(dataLoading
      ? "Inventory saved. Recommendations are loading."
      : dataError || communities.length === 0
        ? "Inventory saved, but recommendation data is unavailable."
        : "Inventory updated. Model-assisted recommendations recalculated.");
  }

  function askFoodFit(question: string) {
    if (!question.trim()) return;

    const q = question.toLowerCase();

    if (q.includes("why") || q.includes("priorit")) {
      setAnswer(
        allocations.length
          ? `${allocations[0].name} ranks highest based on the weighted historical income, transportation, and grocery-access barrier scores. This does not confirm current food demand.`
          : "Recommendation data is not available yet."
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
          <Link to="/" className="brand-small">
            <Leaf size={20} />
            <span>HARVEST GROWTH</span>
          </Link>

          <nav className="navigation-links" aria-label="Main navigation">
            {navigation.map(({ label, icon: Icon, active }) => (
              label === "Planner" || active ? <Link key={label} to={active ? "/dashboard" : "/heatmap"} className={`nav-tab ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}><Icon size={16} /><span>{label}</span></Link> :
              <button
                key={label}
                type="button"
                className={`nav-tab ${active ? "active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  if (!active) setNotice(`${label} page is not built yet.`);
                }}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="account-controls"><UserButton /></div>
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
          <Metric icon={Package} label="Available Meal Kits" value={inventory.kits.toLocaleString()} detail="Entered inventory" />
          <Metric icon={Users} label="Communities Analyzed" value={dataLoading ? "..." : communities.length.toLocaleString()} detail="Texas census tracts" />
          <Metric icon={MapPinned} label="Priority Areas" value={allocations.length.toString()} detail="Model-assisted ranking" />
          <Metric icon={Heart} label="Donation Allocation" value={allocatedTotal.toLocaleString()} detail="Proposed kits, not deliveries" />
        </section>

        <div className="dashboard-main">
          <div className="dashboard-left">
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
                  Other item types are tracked separately and are not allocated yet.
                </p>
              </Panel>

              {/* RECOMMENDED AREAS */}
              <Panel
                title="02 / Top 3 Recommended Areas"
                icon={MapPinned}
                extra={<span className="heading-tag">MODEL-ASSISTED</span>}
              >
                <p className="panel-description">
                  Top three Texas census tracts ranked by historical estimated barriers.
                  Proposed meal-kit allocations use population as a size proxy.
                </p>
                {dataLoading && <p className="tiny-note">Loading predictions...</p>}
                {dataError && <p className="tiny-note" role="alert">{dataError}. Run export_dashboard.py to generate the data file.</p>}
                {!dataLoading && !dataError && allocations.length === 0 && (
                  <p className="tiny-note">No eligible tracts found.</p>
                )}

                <div className="allocation-chart">
                  <div className="chart-bars">
                    {allocations.map((area, index) => (
                      <div className="chart-column" key={area.name}>
                        <div className="chart-value">{area.kits.toLocaleString()}</div>

                        <div className="bar-track">
                          <div
                            className="chart-bar"
                            style={{
                              height: `${(area.kits / maxAllocation) * 100}%`,
                              backgroundColor: area.color,
                            }}
                          />
                        </div>

                        <div className="chart-location">{area.name}</div>
                        <div className="chart-caption">{area.reason}</div>
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
                    <strong>Need score × population</strong>
                  </div>
                </div>
              </Panel>
              {/* CONTRIBUTIONS + IMPACT */}
              <Panel title="03 / Recent Contributions" icon={FileText}>
                <p className="panel-description">
                  Example distribution records for the demo.
                </p>

                <div className="contribution-list">
                  {contributions.map((contribution) => (
                    <div className="contribution-card" key={contribution.name}>
                      <div className="contribution-row">
                        <div className="contribution-symbol">
                          <Package size={18} />
                        </div>

                        <div className="contribution-info">
                          <strong>{contribution.name}</strong>
                          <span>
                            {contribution.item} · {contribution.date}
                          </span>
                        </div>

                        <div className="contribution-amount">+{contribution.amount}</div>
                      </div>

                      <div className="contribution-impact">
                        <div className="impact-data">
                          <span className="impact-label">{contribution.impactLabel}</span>

                          <div className="impact-bar-row">
                            <span>BEFORE</span>
                            <div className="impact-track">
                              <div className="impact-fill before" style={{ width: `${contribution.before}%` }} />
                            </div>
                          </div>

                          <div className="impact-bar-row">
                            <span>AFTER</span>
                            <div className="impact-track">
                              <div className="impact-fill after" style={{ width: `${contribution.after}%` }} />
                            </div>
                          </div>
                        </div>

                        <div className="impact-result">{contribution.result}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <button
                  className="text-action"
                  onClick={() =>
                    setNotice("Contribution history is currently sample data.")
                  }
                >
                  VIEW ALL CONTRIBUTIONS <ArrowRight size={15} />
                </button>

                <p className="tiny-note">
                  These examples are not verified outcomes. Actual impact
                  requires distribution and accessibility data.
                </p>
              </Panel>
            </div>
          </div>
        </div>

        {/* FOOTER */}
        <footer className="page-footer">
          <span>HARVESTGROWTH · IBM Z DATATHON 2026</span>
          <span>
            <HelpCircle size={13} />
            HISTORICAL ML ESTIMATES · PROTOTYPE
          </span>
        </footer>
      </div>

      {/* FLOATING MASCOT CHAT */}
      <div className="chat-widget">
        {chatOpen && (
          <div className="chat-window" role="dialog" aria-label="Ask FoodFit">
            <div className="chat-window-header">
              <div className="chat-window-title">
                <img src={foodfitDrawing} alt="" className="foodfit-chat-header-image" />
                <span>Ask FoodFit</span>
              </div>
              <button
                className="icon-button"
                onClick={() => setChatOpen(false)}
                aria-label="Close chat"
              >
                <X size={16} />
              </button>
            </div>

            <div className="chat-window-body">
              <div className="speech-bubble">
                <strong>HI! I'M FITBASKET!</strong>
                <p>
                  I'll help you explore community needs, manage donations,
                  and understand the results!
                </p>
              </div>

              <p className="panel-description">
                Ask questions about community priorities, inventory, and
                distribution planning.
              </p>

              <div className="suggested-questions">
                {questions.map((question) => (
                  <button key={question} onClick={() => askFoodFit(question)}>
                    <Sparkles size={14} />
                    {question}
                  </button>
                ))}
              </div>

              {answer && (
                <div className="chat-answer" aria-live="polite">
                  <span className="small-label">FOODFIT RESPONSE</span>
                  <strong>{selectedQuestion}</strong>
                  <p>{answer}</p>
                </div>
              )}
            </div>

            <form
              className="chat-input"
              onSubmit={(event) => {
                event.preventDefault();
                askFoodFit(message);
              }}
            >
              <input
                value={message}
                onChange={(event) => setMessage(event.target.value)}
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
        )}

        <button
          className="mascot-fab"
          onClick={() => setChatOpen(!chatOpen)}
          aria-label={chatOpen ? "Close FitBasket chat" : "Open FitBasket chat"}
          aria-expanded={chatOpen}
        >
          <img src={foodfitDrawing} alt="FitBasket mascot" className="foodfit-mascot-image" />
        </button>
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

export default App;
