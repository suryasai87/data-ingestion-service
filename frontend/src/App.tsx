import { lazy, Suspense } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import Shell from "@/components/Shell";
import ErrorBoundary from "@/components/ErrorBoundary";
import { Skeleton } from "@/components/ui";
import Home from "@/pages/Home";

const HowItWorks = lazy(() => import("@/pages/HowItWorks"));
const NewRequest = lazy(() => import("@/pages/NewRequest"));
const Assistant = lazy(() => import("@/pages/Assistant"));
const Requests = lazy(() => import("@/pages/Requests"));
const RequestDetail = lazy(() => import("@/pages/RequestDetail"));
const Pipelines = lazy(() => import("@/pages/Pipelines"));
const Insights = lazy(() => import("@/pages/Insights"));
const Connectors = lazy(() => import("@/pages/Connectors"));
const Admin = lazy(() => import("@/pages/Admin"));

function Loading() {
  return <div className="space-y-4"><Skeleton className="h-9 w-72" /><Skeleton className="h-40 w-full" /><Skeleton className="h-64 w-full" /></div>;
}

export default function App() {
  const loc = useLocation();
  return (
    <Shell>
      <ErrorBoundary resetKey={loc.pathname}>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/how-it-works" element={<HowItWorks />} />
            <Route path="/new" element={<NewRequest />} />
            <Route path="/new/:id" element={<NewRequest />} />
            <Route path="/assistant" element={<Assistant />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/requests/:id" element={<RequestDetail />} />
            <Route path="/pipelines" element={<Pipelines />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/connectors" element={<Connectors />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </Shell>
  );
}
