
import { useState } from "react";
import {
  LayoutDashboard,
  MapPinned,
  BrainCircuit,
  ArrowUpRight,
  Package,
  Store,
  TrendingUp,
  AlertTriangle,
  Sparkles,
  ArrowRight,
  ChevronRight,
  RefreshCw,
  HeartHandshake,
  Leaf,
  Bell,
} from "lucide-react";
import PantryMap from "./PantryMap";

const colors = {
  blue: "#D7E4EE",
  mustard: "#C89A2B",
  navy: "#2E3A46",
  cream: "#FFF9EC",
  border: "#C5D3DD",
};

const pantries = [
  { name: "North Pantry", location: "North Dallas", demand: 120, stock: 40, allocation: 70 },
  { name: "West Pantry", location: "West Dallas", demand: 95, stock: 60, allocation: 30 },
  { name: "South Pantry", location: "South Dallas", demand: 150, stock: 30, allocation: 90 },
  { name: "East Pantry", location: "East Dallas", demand: 110, stock: 50, allocation: 55 },
  { name: "Central Pantry", location: "Central Dallas", demand: 100, stock: 45, allocation: 50 },
];

const panel = "rounded-[24px] border border-[#C5D3DD] bg-white p-6";
const serif = "font-serif tracking-tight";

function PlatePal() {
  const [tipIndex, setTipIndex] = useState(0);

  const tips = [
    "Welcome! I'm PlatePal. Let's make every meal count!",
    "Check pantry shortages to see which communities need help.",
    "Visit Distribution Planner to test a new allocation.",
    "AI Insights will help explain FoodFit's recommendations.",
  ];

  // 12 x 12 pixel plate character
  const sprite = [
    "....kkkk....",
    "..kkwwwwkk..",
    ".kwwwwwwwwk.",
    "kwwwbwwbwwwk",
    "kwwwwwwwwwwk",
    "kwwwwkkwwwwk",
    "kwwwwwwwwwwk",
    ".kwwwwwwwwk.",
    "..kkwwwwkk..",
    "...kkkkkk...",
    "...k....k...",
    "..kk....kk..",
  ];

  return (
    <div className="rounded-[22px] bg-[#FFF3D5] border border-[#E8D19C] p-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="bg-white rounded-2xl border border-[#E8D19C] p-3 shrink-0">
          <div
            className="grid gap-0"
            style={{
              gridTemplateColumns: "repeat(12, 5px)",
              imageRendering: "pixelated",
            }}
          >
            {sprite.join("").split("").map((pixel, index) => (
              <div
                key={index}
                className="w-[5px] h-[5px]"
                style={{
                  backgroundColor:
                    pixel === "k" ? "#35424D" :
                    pixel === "w" ? "#F8D998" :
                    pixel === "b" ? "#35424D" :
                    "transparent",
                }}
              />
            ))}
          </div>
        </div>

        <div>
          <p className="font-bold text-lg">PlatePal</p>
          <p className="text-xs text-[#86704C]">
            Your friendly food guide
          </p>
        </div>
      </div>

      <div className="bg-white/80 rounded-xl p-3 text-sm leading-relaxed min-h-[85px]">
        {tips[tipIndex]}
      </div>

      <button
        onClick={() => setTipIndex((tipIndex + 1) % tips.length)}
        className="mt-3 flex items-center justify-between w-full text-sm font-semibold text-[#816019] cursor-pointer hover:opacity-70"
      >
        Next tip
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

function Sidebar() {
  const links = [
    { label: "Dashboard", icon: LayoutDashboard, active: true },
    { label: "Distribution Planner", icon: MapPinned },
    { label: "AI Insights", icon: BrainCircuit },
  ];

  return (
    <aside className="w-full lg:w-[255px] shrink-0 lg:sticky lg:top-5 lg:h-[calc(100vh-40px)] rounded-[26px] bg-white border border-[#C5D3DD] p-5 flex flex-col">
      <div>
        <div className="px-2 pt-2 pb-8">
          <div className="flex items-center gap-2">
            <Leaf size={27} className="text-[#C89A2B]" />
            <h1 className={`${serif} text-4xl font-black`}>
              FoodFit<span className="text-[#C89A2B]">.</span>
            </h1>
          </div>
          <p className="mt-2 text-xs tracking-[0.15em] uppercase text-[#788897]">
            Food for every community
          </p>
        </div>

        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#9AA8B3] px-3 mb-3">
          Workspace
        </div>

        <nav className="flex flex-col gap-2">
          {links.map(({ label, icon: Icon, active }) => (
            <div
              key={label}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-xl px-4 py-3 font-medium text-sm ${
                active
                  ? "bg-[#C89A2B] text-white"
                  : "bg-[#F4F8FA] text-[#425360]"
              }`}
            >
              <Icon size={18} />
              {label}
            </div>
          ))}
        </nav>
      </div>

      <div className="mt-6 lg:mt-auto">
        <PlatePal />
        <div className="mt-4 flex items-center gap-2 text-xs text-[#84939E] px-2">
          <div className="w-2 h-2 rounded-full bg-[#C89A2B]" />
          Demo mode · Simulated data
        </div>
      </div>
    </aside>
  );
}

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  accent = false,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ComponentType<{ size?: number }>;
  accent?: boolean;
}) {
  return (
    <div className={`${panel} relative overflow-hidden ${accent ? "bg-[#FFF8E8]" : ""}`}>
      <div className="flex justify-between items-start gap-3">
        <p className="text-sm text-[#697A88] font-medium">{label}</p>
        <div className="bg-[#EAF1F5] rounded-xl p-2 text-[#5F7D91]">
          <Icon size={19} />
        </div>
      </div>
      <h3 className={`${serif} text-4xl font-bold mt-3`}>{value}</h3>
      <p className="text-xs text-[#81919D] mt-2">{detail}</p>
    </div>
  );
}

function DemandChart() {
  const max = Math.max(...pantries.map((p) => p.demand));

  return (
    <section className={panel}>
      <div className="flex flex-wrap justify-between items-start gap-3 mb-7">
        <div>
          <p className="uppercase tracking-[0.15em] text-xs font-bold text-[#B48928] mb-2">
            Community analytics
          </p>
          <h3 className={`${serif} text-2xl font-bold`}>
            Pantry Demand Overview
          </h3>
          <p className="text-sm text-[#83919B] mt-1">
            Estimated demand compared to existing food inventory
          </p>
        </div>
        <span className="bg-[#FFF1CE] text-[#927022] px-3 py-1.5 rounded-full text-xs font-semibold">
          Sample data
        </span>
      </div>

      <div className="flex flex-wrap gap-5 mb-4 text-xs text-[#677987]">
        <span className="flex gap-2 items-center">
          <span className="w-3 h-3 rounded-sm bg-[#C89A2B]" />
          Estimated demand
        </span>
        <span className="flex gap-2 items-center">
          <span className="w-3 h-3 rounded-sm bg-[#8BAABB]" />
          Current stock
        </span>
      </div>

      <div className="h-[245px] rounded-2xl bg-[#F4F8FA] border border-[#E2E9EE] px-4 pt-5 pb-3">
        <div className="h-full grid grid-cols-5 items-end gap-3">
          {pantries.map((p) => (
            <div key={p.name} className="flex flex-col items-center justify-end h-full gap-2">
              <div className="w-full max-w-[75px] h-[185px] flex items-end justify-center gap-1">
                <div
                  className="w-[38%] rounded-t-lg bg-[#C89A2B]"
                  style={{ height: `${(p.demand / max) * 100}%` }}
                  title={`Demand: ${p.demand} kits`}
                />
                <div
                  className="w-[38%] rounded-t-lg bg-[#8BAABB]"
                  style={{ height: `${(p.stock / max) * 100}%` }}
                  title={`Stock: ${p.stock} kits`}
                />
              </div>
              <p className="text-xs text-[#627383] whitespace-nowrap">
                {p.name.split(" ")[0]}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PantryOverview() {
  return (
    <section className={panel}>
      <div className="flex justify-between items-center mb-6">
        <div>
          <p className="text-xs uppercase tracking-[0.15em] text-[#B48928] font-bold mb-2">
            Our partners
          </p>
          <h3 className={`${serif} text-2xl font-bold`}>Pantry Overview</h3>
        </div>
        <span className="text-xs text-[#748897]">5 locations</span>
      </div>

      <div className="space-y-3">
        {pantries.map((pantry) => {
          const unmet = Math.max(0, pantry.demand - pantry.stock);

          return (
            <div
              key={pantry.name}
              className="flex flex-wrap sm:flex-nowrap gap-4 items-center justify-between rounded-2xl border border-[#E1E9EE] bg-[#F7FAFC] p-4"
            >
              <div className="flex gap-3 items-center">
                <div className="bg-[#E4EDF3] rounded-xl p-3">
                  <Store size={19} />
                </div>
                <div>
                  <p className="font-semibold">{pantry.name}</p>
                  <p className="text-xs text-[#8694A0] mt-1">
                    {pantry.location}
                  </p>
                </div>
              </div>

              <div className="text-right">
                <p className="font-bold">{unmet} kits</p>
                <p className="text-xs text-[#8694A0]">Unmet demand</p>
              </div>

              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                unmet >= 75
                  ? "bg-[#FBE7DF] text-[#A65C45]"
                  : "bg-[#F8EECF] text-[#926E25]"
              }`}>
                {unmet >= 75 ? "High Need" : "Monitor"}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function App() {
  return (
    <div
      className="min-h-screen bg-[#D7E4EE] text-[#2E3A46] p-3 sm:p-5"
      style={{ color: colors.navy }}
    >
      <div className="max-w-[1700px] mx-auto flex flex-col lg:flex-row gap-5 items-start">

        <Sidebar />

        <main className="flex-1 min-w-0 w-full space-y-5 pb-8">
          {/* Header */}
          <header className={`${panel} flex flex-wrap items-center justify-between gap-4`}>
            <div>
              <p className="text-xs tracking-[0.2em] uppercase font-bold text-[#B48928] mb-2">
                The FoodFit workspace
              </p>
              <h2 className={`${serif} text-3xl sm:text-4xl font-bold`}>
                Community Dashboard
              </h2>
              <p className="text-sm text-[#82929E] mt-2">
                Helping good food reach the places that need it most.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="rounded-full border p-3 border-[#DEE7ED]">
                <Bell size={18} />
              </div>
              <span className="bg-[#FFF2D7] border border-[#EDD39C] rounded-xl px-4 py-3 text-sm font-semibold">
                FoodFit Demo
              </span>
            </div>
          </header>

          {/* Stats */}
          <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <StatCard label="Available Meal Kits" value="500" detail="Sample donated inventory" icon={Package} accent />
            <StatCard label="Partner Pantries" value="5" detail="Simulated locations" icon={Store} />
            <StatCard label="Estimated Unmet Need" value="315" detail="Before new allocations" icon={AlertTriangle} />
            <StatCard label="Current Stock Coverage" value="39%" detail="Across the five locations" icon={TrendingUp} />
          </section>

          {/* Map */}
          <PantryMap />

          {/* Main content */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
            <div className="xl:col-span-2">
              <DemandChart />
            </div>

            <section className={`${panel} flex flex-col`}>
              <div className="flex items-center gap-2 mb-3 text-[#B48928]">
                <Sparkles size={18} />
                <span className="text-xs font-bold uppercase tracking-[0.15em]">
                  Decision support
                </span>
              </div>

              <h3 className={`${serif} text-2xl font-bold mb-2`}>
                Smarter food distribution.
              </h3>
              <p className="text-sm text-[#81929D] leading-relaxed mb-6">
                Analyze inventory and unmet demand to help decide
                how to distribute donated meal kits.
              </p>

              <div className="rounded-2xl bg-[#FFF8EA] border border-[#F0DFB9] p-4 mb-4">
                <p className="text-xs font-semibold text-[#9B792C] uppercase mb-2">
                  Largest current gap
                </p>
                <p className="font-bold text-lg">South Pantry</p>
                <p className="text-sm text-[#756B58] mt-1">
                  120 additional kits needed based on sample data.
                </p>
              </div>

              <div className="rounded-2xl bg-[#F3F8FB] p-4 mb-5">
                <p className="text-sm font-semibold">Next step</p>
                <p className="text-sm text-[#7E8C99] mt-2">
                  Open Distribution Planner to calculate a feasible
                  allocation plan.
                </p>
              </div>

              <div className="mt-auto rounded-xl bg-[#C89A2B] text-white font-semibold px-4 py-3 flex items-center justify-between text-sm">
                Distribution Planner
                <ArrowUpRight size={17} />
              </div>
              <p className="text-xs text-[#8695A0] mt-3">
                Preview only — planner navigation is not connected yet.
              </p>
            </section>
          </div>

          {/* Lower section */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
            <div className="xl:col-span-2">
              <PantryOverview />
            </div>

            <div className="space-y-5">
              <section className={panel}>
                <div className="flex items-center gap-2 mb-4">
                  <BrainCircuit size={20} className="text-[#B48928]" />
                  <h3 className={`${serif} text-2xl font-bold`}>
                    AI Insights
                  </h3>
                </div>

                <p className="text-sm text-[#80919E] mb-4">
                  Explore predicted food demand and potential shortages.
                </p>

                <div className="bg-[#F5F9FB] rounded-xl p-4">
                  <p className="font-semibold text-sm">Forecasting</p>
                  <p className="text-xs text-[#80919E] mt-2">
                    Model results will appear once the prediction
                    backend is connected.
                  </p>
                </div>
              </section>

              <section className={`${panel} bg-[#FFF9EC]`}>
                <div className="flex items-center gap-2 mb-4">
                  <HeartHandshake size={20} className="text-[#B48928]" />
                  <h3 className={`${serif} text-2xl font-bold`}>
                    Our Mission
                  </h3>
                </div>
                <p className="text-sm text-[#768591] leading-relaxed">
                  Every donation counts. FoodFit helps nonprofits
                  plan how to connect available food with
                  communities facing the greatest need.
                </p>
                <div className="mt-5 flex items-center gap-2 text-[#957020] text-sm font-semibold">
                  Good food. Better reach.
                  <ChevronRight size={16} />
                </div>
              </section>
            </div>
          </div>

          <footer className="flex flex-wrap justify-between items-center gap-3 px-2 py-2 text-xs text-[#8294A1]">
            <span>FoodFit © 2026 · Built for the IBM Z Datathon</span>
            <span className="flex items-center gap-2">
              <RefreshCw size={13} />
              Simulated demonstration data
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}

export default App;
