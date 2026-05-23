// flywheel_label_ops.ts — Label Studio API client for Zero Worker.
// Worker-side client for Label Studio REST API via label.zmail.bot Caddy proxy.
// Pattern follows flywheel_training.ts lib style — thin typed HTTP wrapper.
//
// API key stored in CF Worker env (LABEL_STUDIO_API_KEY), never exposed to frontend.
// Frontend calls /api/v1/flywheel/label/* endpoints which proxy through here.
//
// VLA annotation configs (2026-05-18): 4 Label Studio project templates matching
// starlawn annotation pipeline types — cuboid, polygon, trajectory, time_range.
// Each maps to zdata/annotations.py LanceDB schema.

// ─── VLA Label Studio XML configs ─────────────────────────────────────────

// Obstacle bounding box (cuboid) + grass polygon on mower camera frames.
// Aligns with starlawn /annotation/cuboid + /annotation/polygon → zdata CUBOIDS_SCHEMA.
export const VLA_IMAGE_CONFIG = /* xml */ `
<View>
  <Header value="VLA Obstacle & Grass Annotation"/>
  <Image name="frame" value="$image" zoom="true" rotateControl="true"/>

  <RectangleLabels name="cuboid" toName="frame" showInline="false">
    <Label value="obstacle" background="#FF0000" hotkey="1"/>
    <Label value="pedestrian" background="#FF6600" hotkey="2"/>
    <Label value="tree" background="#8B4513" hotkey="3"/>
    <Label value="boundary" background="#0000FF" hotkey="4"/>
    <Label value="charging_station" background="#00FF00" hotkey="5"/>
  </RectangleLabels>

  <PolygonLabels name="polygon" toName="frame" showInline="false">
    <Label value="grass" background="#00FF0040" hotkey="g"/>
    <Label value="sidewalk" background="#80808040" hotkey="s"/>
    <Label value="gravel" background="#DEB88740" hotkey="v"/>
  </PolygonLabels>

  <Choices name="surface" toName="frame" choice="single-radio" showInline="true">
    <Choice value="healthy_grass" hotkey="h"/>
    <Choice value="dry_grass" hotkey="d"/>
    <Choice value="mud" hotkey="m"/>
    <Choice value="unknown" hotkey="u"/>
  </Choices>

  <TextArea name="notes" toName="frame" placeholder="Notes (e.g. mower stuck, edge case)"
            showSubmitButton="false" rows="2" maxlength="200"/>
</View>
`;

// Trajectory waypoint annotation on a static map or overhead view.
// Aligns with starlawn /annotation/trajectory → zdata TRAJECTORIES_SCHEMA.
export const VLA_TRAJECTORY_CONFIG = /* xml */ `
<View>
  <Header value="VLA Path & Trajectory Annotation"/>
  <Image name="map" value="$image" zoom="true"/>

  <KeyPointLabels name="waypoints" toName="map" strokewidth="3">
    <Label value="planned_path" background="#00FF00" hotkey="1"/>
    <Label value="actual_path" background="#0000FF" hotkey="2"/>
    <Label value="boundary" background="#FF0000" hotkey="3"/>
    <Label value="obstacle_avoidance" background="#FF6600" hotkey="4"/>
  </KeyPointLabels>

  <RectangleLabels name="no_go_zone" toName="map" showInline="false">
    <Label value="no_go" background="#FF000080" hotkey="n"/>
  </RectangleLabels>

  <Choices name="path_quality" toName="map" choice="single-radio" showInline="true">
    <Choice value="smooth" hotkey="s"/>
    <Choice value="jerky" hotkey="j"/>
    <Choice value="replan_required" hotkey="r"/>
  </Choices>
</View>
`;

// Temporal event labeling for MCAP time ranges.
// Aligns with starlawn /annotation/time_range → zdata TIME_RANGES_SCHEMA.
export const VLA_TIME_RANGE_CONFIG = /* xml */ `
<View>
  <Header value="VLA Temporal Event Annotation"/>
  <View style="padding: 2em; background: #f8f9fa; border-radius: 12px;">
    <Text name="description" value="$description" />
    <Text name="timestamp" value="$timestamp" />
    <Text name="gps" value="$gps" />
  </View>

  <Choices name="event_type" toName="description" choice="single-radio" showInline="true">
    <Choice value="stuck" hotkey="1"/>
    <Choice value="collision_risk" hotkey="2"/>
    <Choice value="edge_case" hotkey="3"/>
    <Choice value="lost_gps" hotkey="4"/>
    <Choice value="low_battery" hotkey="5"/>
    <Choice value="normal_operation" hotkey="6"/>
  </Choices>

  <Choices name="severity" toName="description" choice="single-radio" showInline="true">
    <Choice value="info" hotkey="i"/>
    <Choice value="warn" hotkey="w"/>
    <Choice value="critical" hotkey="c"/>
  </Choices>

  <TextArea name="notes" toName="description" placeholder="What happened and why?"
            showSubmitButton="false" rows="3" maxlength="500"/>
</View>
`;

// 4 annotation types aligned with zdata/annotations.py schema
export type AnnotationKind = "cuboid" | "polygon" | "trajectory" | "time_range";

const VLA_CONFIGS: Record<AnnotationKind, { title: string; config: string }> = {
  cuboid:   { title: "VLA — Obstacle BBox (Cuboid)", config: VLA_IMAGE_CONFIG },
  polygon:  { title: "VLA — Grass/Surface (Polygon)", config: VLA_IMAGE_CONFIG },
  trajectory: { title: "VLA — Path (Trajectory)", config: VLA_TRAJECTORY_CONFIG },
  time_range: { title: "VLA — Events (Time Range)", config: VLA_TIME_RANGE_CONFIG },
};

// ─── Exported types ────────────────────────────────────────────────────────

export interface LabelStudioProject {
  id: number;
  title: string;
  label_config: string;
  created_at: string;
  task_number?: number;
  total_annotations?: number;
  total_predictions_number?: number;
}

export interface LabelStudioTask {
  id: number;
  project: number;
  data: Record<string, unknown>;
  annotations?: Array<{ id: number; result: unknown[] }>;
  predictions?: Array<{ id: number; result: unknown[] }>;
  created_at?: string;
  updated_at?: string;
}

export function createLSClient(apiKey: string, baseUrl: string) {
  const authHeaders = {
    Authorization: `Token ${apiKey}`,
    "Content-Type": "application/json",
  };

  async function ls<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...authHeaders, ...(init?.headers as Record<string, string>) },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LS API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  return {
    listProjects(): Promise<LabelStudioProject[]> {
      return ls<{ results: LabelStudioProject[] }>("/api/projects")
        .then((d) => d.results);
    },

    async getProject(id: number): Promise<LabelStudioProject | null> {
      try { return await ls<LabelStudioProject>(`/api/projects/${id}`); }
      catch { return null; }
    },

    createProject(title: string, labelConfig: string): Promise<LabelStudioProject> {
      return ls<LabelStudioProject>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ title, label_config: labelConfig }),
      });
    },

    async listTasks(
      projectId: number,
      page = 1,
    ): Promise<{ tasks: LabelStudioTask[]; total: number }> {
      const data = await ls<{
        tasks: LabelStudioTask[];
        total_count: number;
      }>(`/api/tasks?project=${projectId}&page=${page}&page_size=50`);
      return { tasks: data.tasks, total: data.total_count };
    },

    createTask(
      projectId: number,
      data: Record<string, unknown>,
    ): Promise<LabelStudioTask> {
      return ls<LabelStudioTask>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ project: projectId, data }),
      });
    },

    async createTasksBatch(
      projectId: number,
      tasks: Array<{ data: Record<string, unknown> }>,
    ): Promise<number> {
      const result = await ls<{ ids: number[] }>("/api/tasks/bulk", {
        method: "POST",
        body: JSON.stringify(
          tasks.map((t) => ({ project: projectId, data: t.data })),
        ),
      });
      return result.ids.length;
    },

    async importPredictions(
      projectId: number,
      preds: Array<{ task: number; result: unknown[] }>,
    ): Promise<number> {
      const result = await ls<{ ids?: number[] }>("/api/predictions", {
        method: "POST",
        body: JSON.stringify(
          preds.map((p) => ({ task: p.task, result: p.result, project: projectId })),
        ),
      });
      return result.ids?.length ?? 0;
    },

    /** Fetch all annotations for a project. Returns completed + cancelled. */
    async listAnnotations(projectId: number): Promise<LSAnnotation[]> {
      const all: LSAnnotation[] = [];
      let page = 1;
      while (true) {
        const data = await ls<{
          results?: LSAnnotation[];
          total_count?: number;
        }>(`/api/annotations?project=${projectId}&page=${page}&page_size=100`);
        const results = data.results ?? (Array.isArray(data) ? data as unknown as LSAnnotation[] : []);
        all.push(...results);
        const total = data.total_count ?? 0;
        if (all.length >= total || results.length === 0) break;
        page++;
      }
      return all;
    },
  };
}

// ─── VLA project auto-creation ────────────────────────────────────────────

export interface VLACreateProjectsResult {
  ok: boolean;
  projects: Record<AnnotationKind, { project_id: number; title: string } | null>;
  error?: string;
}

/** Auto-create all 4 VLA annotation project types in Label Studio.
 *  Skips any kind where the config is undefined (partial creation).
 *  Used by starlawn annotation pipeline to set up per-dataset annotation projects. */
export async function createVLAProjects(
  client: ReturnType<typeof createLSClient>,
  datasetName: string,
  kinds: AnnotationKind[] = ["cuboid", "polygon", "trajectory", "time_range"],
): Promise<VLACreateProjectsResult> {
  const projects = {} as VLACreateProjectsResult["projects"];

  for (const kind of kinds) {
    const cfg = VLA_CONFIGS[kind];
    if (!cfg) {
      projects[kind] = null;
      continue;
    }
    try {
      const title = `${cfg.title} — ${datasetName}`;
      const proj = await client.createProject(title, cfg.config);
      projects[kind] = { project_id: proj.id, title };
    } catch (e) {
      // 409 conflict = project already exists, skip
      projects[kind] = null;
      if (!String(e).includes("409")) throw e;
    }
  }

  const created = Object.values(projects).filter(Boolean).length;
  return { ok: created > 0, projects };
}

// ─── Annotation Export (Phase 3.3: LS → zdata LanceDB round-trip) ─────────

export interface LSAnnotation {
  id: number;
  task: number;
  result: LSResultItem[];
  was_cancelled: boolean;
  created_at: string;
  updated_at: string;
  completed_by?: { id: number; email: string };
}

export interface LSResultItem {
  id: string;
  type: "rectanglelabels" | "polygonlabels" | "keypointlabels" | "choices" | "textarea" | string;
  value: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    rotation?: number;
    rectanglelabels?: string[];
    points?: number[][];
    polygonlabels?: string[];
    keypointlabels?: string[];
    choices?: string[];
    text?: string[];
  };
  from_name: string;
  to_name: string;
}

// zdata row types — aligned with datazero/zdata/annotations.py LanceDB schemas

export interface ZdataCuboidRow {
  annotation_id: string;
  frame_id: string;
  mcap_file: string;
  mower_id: string;
  x: number; y: number; z: number;
  roll_deg: number; pitch_deg: number; yaw_deg: number;
  size_x: number; size_y: number; size_z: number;
  r: number; g: number; b: number; a: number;
  label: string;
  confidence: number;
  annotator: string;
  review_status: string;
  created_at: string;
  tags: string;
}

export interface ZdataPolygonRow {
  annotation_id: string;
  frame_id: string;
  mcap_file: string;
  mower_id: string;
  vertices: string;
  label: string;
  confidence: number;
  annotator: string;
  review_status: string;
  created_at: string;
  tags: string;
}

export interface ZdataTrajectoryRow {
  annotation_id: string;
  mcap_file: string;
  mower_id: string;
  waypoints: string;
  thickness: number;
  r: number; g: number; b: number; a: number;
  label: string;
  confidence: number;
  annotator: string;
  review_status: string;
  created_at: string;
  tags: string;
}

export interface ZdataTimeRangeRow {
  annotation_id: string;
  mcap_file: string;
  mower_id: string;
  start_tick: number;
  end_tick: number;
  start_timestamp_ns: number;
  end_timestamp_ns: number;
  label: string;
  severity: string;
  annotator: string;
  review_status: string;
  created_at: string;
  notes: string;
}

export interface AnnotationExportBatch {
  dataset_name: string;
  exported_at: string;
  cuboids: ZdataCuboidRow[];
  polygons: ZdataPolygonRow[];
  trajectories: ZdataTrajectoryRow[];
  time_ranges: ZdataTimeRangeRow[];
  stats: {
    total_tasks: number;
    total_annotations: number;
    by_project: Record<string, { tasks: number; annotations: number }>;
  };
}

// ─── LS → zdata converters ───────────────────────────────────────────────

interface TaskContext {
  frame_id: string;
  mcap_file: string;
  mower_id: string;
  timestamps?: { start_tick?: number; end_tick?: number; start_ns?: number; end_ns?: number };
}

function uid(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

function convertCuboid(
  item: LSResultItem,
  taskId: number,
  ctx: TaskContext,
  annotator: string,
): ZdataCuboidRow | null {
  if (item.type !== "rectanglelabels") return null;
  const v = item.value;
  if (v.x == null || v.y == null || v.width == null || v.height == null) return null;

  const label = v.rectanglelabels?.[0] || "unknown";
  return {
    annotation_id: uid(),
    frame_id: ctx.frame_id,
    mcap_file: ctx.mcap_file,
    mower_id: ctx.mower_id,
    x: v.x, y: 0, z: v.y, // LS image y → world z (flat ground)
    roll_deg: 0, pitch_deg: 0, yaw_deg: v.rotation ?? 0,
    size_x: v.width, size_y: 0.5, size_z: v.height,
    r: 1.0, g: 0.0, b: 0.0, a: 1.0,
    label,
    confidence: 1.0,
    annotator,
    review_status: "approved",
    created_at: nowISO(),
    tags: JSON.stringify(["label-studio", `task:${taskId}`]),
  };
}

function convertPolygon(
  item: LSResultItem,
  taskId: number,
  ctx: TaskContext,
  annotator: string,
): ZdataPolygonRow | null {
  if (item.type !== "polygonlabels") return null;
  const v = item.value;
  if (!v.points || v.points.length < 3) return null;

  return {
    annotation_id: uid(),
    frame_id: ctx.frame_id,
    mcap_file: ctx.mcap_file,
    mower_id: ctx.mower_id,
    vertices: JSON.stringify(v.points),
    label: v.polygonlabels?.[0] || "unknown",
    confidence: 1.0,
    annotator,
    review_status: "approved",
    created_at: nowISO(),
    tags: JSON.stringify(["label-studio", `task:${taskId}`]),
  };
}

function convertTrajectory(
  items: LSResultItem[],
  taskId: number,
  ctx: TaskContext,
  annotator: string,
): ZdataTrajectoryRow | null {
  const keypoints = items.filter((i) => i.type === "keypointlabels");
  if (keypoints.length === 0) return null;

  const waypoints: number[][] = [];
  let label = "unknown";
  for (const kp of keypoints) {
    const v = kp.value;
    if (v.x == null || v.y == null) continue;
    waypoints.push([v.x, v.y, 0]);
    if (v.keypointlabels?.[0]) label = v.keypointlabels[0];
  }
  if (waypoints.length === 0) return null;

  return {
    annotation_id: uid(),
    mcap_file: ctx.mcap_file,
    mower_id: ctx.mower_id,
    waypoints: JSON.stringify(waypoints),
    thickness: 2.0,
    r: 0.0, g: 1.0, b: 0.0, a: 1.0,
    label,
    confidence: 1.0,
    annotator,
    review_status: "approved",
    created_at: nowISO(),
    tags: JSON.stringify(["label-studio", `task:${taskId}`]),
  };
}

function convertTimeRange(
  items: LSResultItem[],
  ctx: TaskContext,
  annotator: string,
): ZdataTimeRangeRow | null {
  const choices = items.filter((i) => i.type === "choices");
  const textareas = items.filter((i) => i.type === "textarea");

  let label = "unknown";
  let severity = "info";
  for (const ch of choices) {
    const selected = ch.value.choices?.[0];
    if (!selected) continue;
    if (["info", "warn", "critical"].includes(selected)) {
      severity = selected;
    } else {
      label = selected;
    }
  }
  const notes = textareas.map((t) => t.value.text?.[0] || "").filter(Boolean).join("; ");

  return {
    annotation_id: uid(),
    mcap_file: ctx.mcap_file,
    mower_id: ctx.mower_id,
    start_tick: ctx.timestamps?.start_tick ?? 0,
    end_tick: ctx.timestamps?.end_tick ?? 0,
    start_timestamp_ns: ctx.timestamps?.start_ns ?? 0,
    end_timestamp_ns: ctx.timestamps?.end_ns ?? 0,
    label,
    severity,
    annotator,
    review_status: "approved",
    created_at: nowISO(),
    notes,
  };
}

// ─── Public API: exportAnnotations ────────────────────────────────────────

/** Fetch completed annotations from all 4 VLA Label Studio projects for a dataset
 *  and convert them to zdata LanceDB row format. */
export async function exportAnnotations(
  apiKey: string,
  baseUrl: string,
  datasetName: string,
  kinds: AnnotationKind[] = ["cuboid", "polygon", "trajectory", "time_range"],
): Promise<AnnotationExportBatch> {
  const client = createLSClient(apiKey, baseUrl);

  const allProjects = await client.listProjects();
  const matchTitle = (kind: AnnotationKind): string =>
    VLA_CONFIGS[kind]?.title ?? "";

  const projectMap: Partial<Record<AnnotationKind, number>> = {};
  for (const proj of allProjects) {
    for (const kind of kinds) {
      if (proj.title === `${matchTitle(kind)} — ${datasetName}`) {
        projectMap[kind] = proj.id;
      }
    }
  }

  const cuboids: ZdataCuboidRow[] = [];
  const polygons: ZdataPolygonRow[] = [];
  const trajectories: ZdataTrajectoryRow[] = [];
  const timeRanges: ZdataTimeRangeRow[] = [];
  const stats: AnnotationExportBatch["stats"] = {
    total_tasks: 0,
    total_annotations: 0,
    by_project: {},
  };

  for (const kind of kinds) {
    const projectId = projectMap[kind];
    if (!projectId) {
      stats.by_project[kind] = { tasks: 0, annotations: 0 };
      continue;
    }

    const { tasks } = await client.listTasks(projectId, 1);
    const annotations = await client.listAnnotations(projectId);
    const completed = annotations.filter((a) => !a.was_cancelled && a.result?.length);

    const taskMap = new Map<number, (typeof tasks)[number]>();
    for (const t of tasks) taskMap.set(t.id, t);

    let annCount = 0;
    for (const ann of completed) {
      const task = taskMap.get(ann.task);
      const taskData = (task?.data ?? {}) as Record<string, unknown>;

      const ctx: TaskContext = {
        frame_id: (taskData.frame_id as string) || (taskData.image as string) || `task:${ann.task}`,
        mcap_file: (taskData.mcap_file as string) || datasetName,
        mower_id: (taskData.mower_id as string) || "unknown",
        timestamps: {
          start_tick: taskData.start_tick as number | undefined,
          end_tick: taskData.end_tick as number | undefined,
          start_ns: taskData.start_timestamp_ns as number | undefined,
          end_ns: taskData.end_timestamp_ns as number | undefined,
        },
      };

      const annotator = ann.completed_by?.email
        ? `human:${ann.completed_by.email}`
        : "human:unknown";

      for (const item of ann.result) {
        switch (kind) {
          case "cuboid": {
            const row = convertCuboid(item, ann.task, ctx, annotator);
            if (row) { cuboids.push(row); annCount++; }
            break;
          }
          case "polygon": {
            const row = convertPolygon(item, ann.task, ctx, annotator);
            if (row) { polygons.push(row); annCount++; }
            break;
          }
          case "trajectory": {
            const row = convertTrajectory(ann.result, ann.task, ctx, annotator);
            if (row) { trajectories.push(row); annCount++; }
            break;
          }
          case "time_range": {
            const row = convertTimeRange(ann.result, ctx, annotator);
            if (row) { timeRanges.push(row); annCount++; }
            break;
          }
        }
      }
      stats.total_annotations++;
    }

    stats.by_project[kind] = { tasks: tasks.length, annotations: annCount };
    stats.total_tasks += tasks.length;
  }

  return {
    dataset_name: datasetName,
    exported_at: nowISO(),
    cuboids,
    polygons,
    trajectories,
    time_ranges: timeRanges,
    stats,
  };
}
