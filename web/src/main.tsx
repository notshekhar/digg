import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NuqsAdapter } from "nuqs/adapters/react";
import "./styles/base.css";
import { App } from "./app.tsx";

const el = document.getElementById("root");
if (!el) throw new Error("digg: #root missing");

createRoot(el).render(
    <StrictMode>
        {/* nuqs owns the query string; the path is ours (lib/router.ts). */}
        <NuqsAdapter>
            <App />
        </NuqsAdapter>
    </StrictMode>,
);
