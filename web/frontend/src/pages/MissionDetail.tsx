import { useLocation, useRoute } from "wouter";
import { Layout } from "../components/Layout";
import { MissionDetailContent } from "../components/missions/MissionDetailContent";

export function MissionDetail() {
  const [, params] = useRoute("/missions/:id");
  const [, navigate] = useLocation();
  const id = params?.id ?? "";

  return (
    <Layout title="Mission">
      <MissionDetailContent
        id={id}
        onBack={() => navigate("/missions")}
        backLabel="Missions"
      />
    </Layout>
  );
}
