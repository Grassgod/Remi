import { Route, Switch, Router as WouterRouter } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Dashboard } from "./pages/Dashboard";
import { Memory } from "./pages/Memory";
import { MemoryEntity } from "./pages/MemoryEntity";
import { MemoryDaily } from "./pages/MemoryDaily";
import { Sessions } from "./pages/Sessions";
import { Auth } from "./pages/Auth";
import { Config } from "./pages/Config";
import { Projects } from "./pages/Projects";
import { Layout } from "./components/Layout";

function Placeholder({ title }: { title: string }) {
  return (
    <Layout title={title} subtitle="COMING SOON">
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        height: "60vh",
      }}>
        <div style={{
          textAlign: "center",
          fontFamily: "var(--font-display)", fontSize: 14,
          color: "var(--text-dim)", letterSpacing: 3,
        }}>
          <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.3 }}>◇</div>
          {title.toUpperCase()} MODULE
          <div style={{
            fontFamily: "var(--font-mono)", fontSize: 10,
            marginTop: 8, letterSpacing: 1,
          }}>PHASE 2 IMPLEMENTATION</div>
        </div>
      </div>
    </Layout>
  );
}

export function App() {
  return (
    <WouterRouter hook={useHashLocation}>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/memory" component={Memory} />
        <Route path="/memory/entity/:type/:name" component={MemoryEntity} />
        <Route path="/memory/daily/:date" component={MemoryDaily} />
        <Route path="/sessions" component={Sessions} />
        <Route path="/auth" component={Auth} />
        <Route path="/config" component={Config} />
        <Route path="/projects" component={Projects} />
        <Route path="/scheduler">{() => <Placeholder title="Scheduler" />}</Route>
        <Route path="/tools">{() => <Placeholder title="Tools" />}</Route>
        <Route path="/monitor">{() => <Placeholder title="Monitor" />}</Route>
        <Route>{() => <Placeholder title="Not Found" />}</Route>
      </Switch>
    </WouterRouter>
  );
}
