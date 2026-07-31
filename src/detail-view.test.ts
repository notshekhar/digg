import { describe, expect, test } from "bun:test";
import type { K8sObject } from "./kubectl.ts";
import {
    type Fact,
    type FactGroup,
    nodeAffinityLines,
    podLine,
    podView,
    referencesGroup,
    tolerationLines,
    topologySpreadLines,
    workloadView,
} from "./detail-view.ts";
import { NO_METRICS, metricsFromContainers } from "./usage.ts";

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const fact = (group: FactGroup, label: string): Fact | undefined => group.facts.find((f) => f.label === label);
const findFact = (groups: FactGroup[], label: string): Fact | undefined =>
    groups.flatMap((g) => g.facts).find((f) => f.label === label);

const POD: K8sObject = {
    kind: "Pod",
    metadata: {
        name: "web-abc",
        namespace: "demo",
        creationTimestamp: iso(60),
        labels: { app: "web" },
        annotations: { "kubectl.kubernetes.io/restartedAt": "2026-06-20T15:45:29+05:30" },
        ownerReferences: [{ kind: "ReplicaSet", name: "web-5f7", controller: true }],
    },
    spec: {
        nodeName: "node-1",
        serviceAccountName: "web-sa",
        restartPolicy: "Always",
        tolerations: [{ key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 }],
        containers: [
            {
                name: "app",
                image: "example/app:1",
                ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }],
                resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { cpu: "100m", memory: "96Mi" } },
            },
        ],
    },
    status: {
        phase: "Running",
        podIP: "10.0.0.9",
        hostIP: "192.168.1.5",
        qosClass: "Burstable",
        startTime: iso(60),
        conditions: [
            { type: "Initialized", status: "True" },
            { type: "Ready", status: "False", reason: "ContainersNotReady" },
        ],
        containerStatuses: [
            {
                name: "app",
                ready: true,
                started: true,
                restartCount: 2,
                state: { running: { startedAt: iso(30) } },
                lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: iso(31) } },
            },
        ],
    },
};

describe("podView", () => {
    const view = podView(POD, metricsFromContainers(new Map([["demo/web-abc/app", { cpu: "7m", memory: "40Mi" }]])));

    test("identity card carries owner, labels and annotations", () => {
        expect(fact(view.header, "Owner")?.ref).toEqual({ kind: "replicasets", name: "web-5f7", ns: "demo" });
        expect(fact(view.header, "Labels")?.chips).toEqual([{ k: "app", v: "web" }]);
        expect(fact(view.header, "Annotations")?.chips?.[0]?.k).toBe("kubectl.kubernetes.io/restartedAt");
    });

    test("node and service account are links, not text", () => {
        expect(findFact(view.groups, "Node")?.ref).toEqual({ kind: "nodes", name: "node-1" });
        expect(findFact(view.groups, "Service Account")?.ref).toEqual({
            kind: "serviceaccounts",
            name: "web-sa",
            ns: "demo",
        });
    });

    test("conditions are toned by status", () => {
        const chips = findFact(view.groups, "Conditions")?.chips ?? [];
        expect(chips[0]).toEqual({ v: "Initialized", tone: "ok" });
        expect(chips[1]).toEqual({ v: "Ready: ContainersNotReady", tone: "bad" });
    });

    test("the container card keeps the reason the last crash happened", () => {
        const c = view.containers[0]!;
        expect(c.state).toBe("Running");
        expect(c.stateTone).toBe("ok");
        expect(c.restarts).toBe(2);
        expect(c.restartReason).toBe("OOMKilled");
        expect(c.ports).toBe("http:8080/TCP");
        expect(c.cpu.used).toBeCloseTo(0.007);
        expect(c.cpu.limits).toBeCloseTo(0.1);
        expect(c.mem.used).toBe(40 * 1024 * 1024);
    });

    test("usage is unknown, not zero, without metrics", () => {
        const bare = podView(POD, NO_METRICS);
        expect(bare.containers[0]!.cpu.used).toBeNull();
        expect(bare.containers[0]!.cpu.requests).toBeCloseTo(0.025);
    });
});

describe("scheduling summaries", () => {
    test("tolerations read as key: effect", () => {
        expect(tolerationLines(POD.spec!)).toEqual(["node.kubernetes.io/not-ready: NoExecute for 300s"]);
    });

    test("node affinity flattens required and preferred terms", () => {
        const spec = {
            affinity: {
                nodeAffinity: {
                    requiredDuringSchedulingIgnoredDuringExecution: {
                        nodeSelectorTerms: [{ matchExpressions: [{ key: "disk", operator: "In", values: ["ssd"] }] }],
                    },
                    preferredDuringSchedulingIgnoredDuringExecution: [
                        { weight: 10, preference: { matchExpressions: [{ key: "zone", operator: "In", values: ["a"] }] } },
                    ],
                },
            },
        };
        expect(nodeAffinityLines(spec)).toEqual(["required: disk In ssd", "preferred (10): zone In a"]);
    });

    test("topology spread constraints keep skew and policy", () => {
        expect(
            topologySpreadLines({
                topologySpreadConstraints: [
                    { topologyKey: "kubernetes.io/hostname", maxSkew: 2, whenUnsatisfiable: "ScheduleAnyway" },
                ],
            }),
        ).toEqual(["kubernetes.io/hostname · maxSkew 2 · ScheduleAnyway"]);
    });
});

describe("podLine", () => {
    test("summarises a pod for the workload table", () => {
        const line = podLine(POD, NO_METRICS);
        expect(line.ready).toBe("1/1");
        expect(line.status).toBe("Running");
        expect(line.restarts).toBe(2);
        expect(line.lastRestartReason).toBe("OOMKilled");
        expect(line.node).toBe("node-1");
    });
});

describe("workloadView", () => {
    const deployment: K8sObject = {
        kind: "Deployment",
        metadata: { name: "web", namespace: "demo", creationTimestamp: iso(120), labels: { app: "web" } },
        spec: {
            replicas: 2,
            selector: { matchLabels: { app: "web" } },
            strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } },
            template: {
                spec: {
                    containers: [
                        {
                            name: "app",
                            image: "example/app:1",
                            resources: { requests: { cpu: "25m" }, limits: { cpu: "100m" } },
                        },
                    ],
                },
            },
        },
        status: { replicas: 2, readyReplicas: 2, updatedReplicas: 2, availableReplicas: 1, conditions: [{ type: "Available", status: "True" }] },
    };

    const pods = [POD, { ...POD, metadata: { ...POD.metadata, name: "web-def" } } as K8sObject];
    const view = workloadView(
        deployment,
        "deployments",
        pods,
        metricsFromContainers(
            new Map([
                ["demo/web-abc/app", { cpu: "7m", memory: "40Mi" }],
                ["demo/web-def/app", { cpu: "3m", memory: "20Mi" }],
            ]),
        ),
    );

    test("rollout group carries the strategy knobs", () => {
        const rollout = view.groups[0]!;
        expect(rollout.title).toBe("Rollout");
        expect(fact(rollout, "Strategy")?.text).toBe("RollingUpdate");
        expect(fact(rollout, "Max Surge")?.text).toBe("25%");
        expect(fact(rollout, "Max Unavailable")?.text).toBe("25%");
        expect(fact(rollout, "Conditions")?.chips).toEqual([{ v: "Available", tone: "ok" }]);
    });

    test("counts come from the status, pods from the list", () => {
        expect(view.pods).toMatchObject({ desired: 2, updated: 2, ready: 2, available: 1 });
        expect(view.pods!.rows.map((r) => r.name)).toEqual(["web-abc", "web-def"]);
    });

    test("container usage is summed over the pods and says so", () => {
        expect(view.containers[0]!.cpu.used).toBeCloseTo(0.01);
        expect(view.containers[0]!.cpu.requests).toBeCloseTo(0.05); // 2 × 25m
        expect(view.containersNote).toBe("summed over 2 pods");
    });

    test("a single replica needs no aggregation note", () => {
        const single = workloadView(deployment, "deployments", [POD], NO_METRICS);
        expect(single.containersNote).toBeUndefined();
        expect(single.containers[0]!.cpu.requests).toBeCloseTo(0.025);
    });
});

describe("references", () => {
    const SPEC = {
        serviceAccountName: "web-sa",
        priorityClassName: "high",
        imagePullSecrets: [{ name: "registry-cred" }],
        volumes: [
            { name: "config", configMap: { name: "web-config" } },
            { name: "tls", secret: { secretName: "web-tls" } },
            { name: "data", persistentVolumeClaim: { claimName: "web-data" } },
            {
                name: "bundle",
                projected: { sources: [{ configMap: { name: "ca-bundle" } }, { secret: { name: "web-tls" } }] },
            },
            { name: "vault", csi: { nodePublishSecretRef: { name: "csi-cred" } } },
            { name: "share", cephfs: { secretRef: { name: "ceph-key" } } },
            { name: "scratch", emptyDir: {} },
        ],
        containers: [
            {
                name: "app",
                envFrom: [{ configMapRef: { name: "web-config" } }, { secretRef: { name: "app-env" } }],
                env: [
                    { name: "PLAIN", value: "x" },
                    { name: "DB_PASS", valueFrom: { secretKeyRef: { name: "db", key: "password" } } },
                    { name: "DB_HOST", valueFrom: { configMapKeyRef: { name: "db-conf", key: "host" } } },
                ],
            },
        ],
        initContainers: [{ name: "migrate", envFrom: [{ secretRef: { name: "db" } }] }],
    };

    const group = referencesGroup(SPEC, "demo", true)!;
    const refs = (label: string) => fact(group, label)?.refs ?? [];
    const names = (label: string) => refs(label).map((r) => r.name).sort();

    test("collects configmaps from volumes, projections, envFrom and env", () => {
        expect(names("ConfigMaps")).toEqual(["ca-bundle", "db-conf", "web-config"]);
    });

    test("collects secrets from every carrier the API server resolves", () => {
        expect(names("Secrets")).toEqual(["app-env", "ceph-key", "csi-cred", "db", "registry-cred", "web-tls"]);
    });

    test("claims are their own kind, and volumes with no reference are skipped", () => {
        expect(refs("Volume Claims")).toEqual([
            { kind: "persistentvolumeclaims", name: "web-data", ns: "demo", via: "volume data" },
        ]);
    });

    test("refs are namespaced so a link lands in the right namespace", () => {
        expect(refs("ConfigMaps").every((r) => r.ns === "demo")).toBe(true);
    });

    test("a name reached twice appears once, carrying both routes", () => {
        const cm = refs("ConfigMaps").find((r) => r.name === "web-config");
        expect(cm?.via).toBe("volume config, envFrom in app");
        const tls = refs("Secrets").find((r) => r.name === "web-tls");
        expect(tls?.via).toBe("volume tls, projected bundle");
    });

    test("env references name the variable, init containers name themselves", () => {
        expect(refs("Secrets").find((r) => r.name === "db")?.via).toBe("envFrom in migrate, env DB_PASS");
        expect(refs("ConfigMaps").find((r) => r.name === "db-conf")?.via).toBe("env DB_HOST");
    });

    test("many routes to one name are summarized rather than listed", () => {
        const many = referencesGroup(
            {
                containers: [
                    {
                        name: "app",
                        env: ["A", "B", "C", "D", "E"].map((n) => ({
                            name: n,
                            valueFrom: { secretKeyRef: { name: "big", key: n } },
                        })),
                    },
                ],
            },
            "demo",
        )!;
        expect(fact(many, "Secrets")?.refs?.[0]?.via).toBe("env A, env B +3 more");
    });

    test("identity adds links the workload has nowhere else to show", () => {
        expect(fact(group, "Service Account")?.ref).toEqual({ kind: "serviceaccounts", name: "web-sa", ns: "demo" });
        // Cluster-scoped: a namespace on this link would 404.
        expect(fact(group, "Priority Class")?.ref).toEqual({ kind: "priorityclasses", name: "high" });
        expect(fact(referencesGroup(SPEC, "demo")!, "Service Account")).toBeUndefined();
    });

    test("a spec that names nothing gets no group at all", () => {
        expect(referencesGroup({ containers: [{ name: "app", image: "x" }] })).toBeNull();
        expect(referencesGroup({})).toBeNull();
    });

    const deploy = (podSpec: Record<string, unknown>): K8sObject => ({
        kind: "Deployment",
        metadata: { name: "web", namespace: "demo", creationTimestamp: iso(10) },
        spec: { replicas: 1, template: { spec: podSpec } },
        status: {},
    });

    test("the workload page shows references above scheduling, and skips the group when empty", () => {
        const bare = workloadView(deploy({ containers: [{ name: "app", image: "x" }] }), "deployments", [], NO_METRICS);
        expect(bare.groups.map((g) => g.title)).toEqual(["Rollout", "Scheduling"]);

        const rich = workloadView(deploy(SPEC), "deployments", [], NO_METRICS);
        expect(rich.groups.map((g) => g.title)).toEqual(["Rollout", "References", "Scheduling"]);
    });

    test("a pod reads its own template's references and links its priority class", () => {
        const pod = { kind: "Pod", metadata: { name: "web-1", namespace: "demo" }, spec: SPEC } as K8sObject;
        const view = podView(pod, NO_METRICS);
        const group = view.groups.find((g) => g.title === "References")!;
        expect(group.facts.map((f) => f.label)).toEqual(["ConfigMaps", "Secrets", "Volume Claims"]);
        expect(findFact(view.groups, "Priority Class")?.ref).toEqual({ kind: "priorityclasses", name: "high" });
    });
});
