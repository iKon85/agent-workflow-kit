import { validateReconReport } from './reportValidator.mjs';

const byPath = (left, right) => left.path.localeCompare(right.path);
const bySlice = (left, right) => left.localeCompare(right, 'en', { numeric: true });
const edgeKey = ({ from, to }) => `${from}:${to}`;

function validateReports(reports) {
  if (!Array.isArray(reports)) throw new TypeError('recon reports must be an array');
  const sliceIds = new Set();
  for (const report of reports) {
    const validation = validateReconReport(report);
    if (!validation.ok) throw new Error(`invalid recon report: ${validation.errors.join('; ')}`);
    if (sliceIds.has(report.sliceId)) throw new Error(`duplicate recon report for slice ${report.sliceId}`);
    sliceIds.add(report.sliceId);
  }
  return sliceIds;
}

function buildGraph(reports, sliceIds) {
  const edges = new Map();
  const successors = new Map([...sliceIds].map((id) => [id, new Set()]));
  const indegree = new Map([...sliceIds].map((id) => [id, 0]));
  for (const { dependencyEdges } of reports) {
    for (const edge of dependencyEdges) {
      if (!sliceIds.has(edge.from) || !sliceIds.has(edge.to)) {
        const unknown = !sliceIds.has(edge.from) ? edge.from : edge.to;
        throw new Error(`dependency edge references unknown slice ${unknown}`);
      }
      if (edge.from === edge.to) throw new Error(`self dependency is not allowed for slice ${edge.from}`);
      if (edges.has(edgeKey(edge))) continue;
      edges.set(edgeKey(edge), edge);
      successors.get(edge.from).add(edge.to);
      indegree.set(edge.to, indegree.get(edge.to) + 1);
    }
  }
  const ready = [...sliceIds].filter((id) => indegree.get(id) === 0).sort(bySlice);
  const order = [];
  while (ready.length > 0) {
    const current = ready.shift();
    order.push(current);
    for (const next of [...successors.get(current)].sort(bySlice)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
    ready.sort(bySlice);
  }
  if (order.length !== sliceIds.size) throw new Error('dependency graph contains a cycle');
  return { edges: [...edges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))), successors, order };
}

function collectFiles(reports) {
  const files = new Map();
  for (const { sliceId, plannedFiles } of reports) {
    for (const { path, role } of plannedFiles) {
      const file = files.get(path) ?? { editors: new Set(), shared: false };
      if (role === 'edit') file.editors.add(sliceId);
      if (role === 'sharedMutable') file.shared = true;
      files.set(path, file);
    }
  }
  return files;
}

function canReach(from, to, successors) {
  const pending = [...successors.get(from)];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...successors.get(current));
  }
  return false;
}

function orderedEditors(path, file, graph) {
  const editors = [...file.editors];
  if (file.shared && editors.length !== 1) {
    const found = editors.sort(bySlice);
    throw new Error(`${path} must have exactly one edit owner; found ${found.length ? found.join(', ') : '0'}`);
  }
  const position = new Map(graph.order.map((id, index) => [id, index]));
  editors.sort((left, right) => position.get(left) - position.get(right));
  for (let left = 0; left < editors.length; left += 1) {
    for (let right = left + 1; right < editors.length; right += 1) {
      if (!canReach(editors[left], editors[right], graph.successors)) {
        throw new Error(`${path} edit owners are not totally ordered by dependencies`);
      }
    }
  }
  return editors;
}

/** Reconcile schema-valid per-slice recon reports before any builder dispatch. */
export function reconcileReconReports(reports) {
  const sliceIds = validateReports(reports);
  const graph = buildGraph(reports, sliceIds);
  const editOwners = [];
  const overlaps = [];
  for (const [path, file] of collectFiles(reports)) {
    const sliceIdsForPath = orderedEditors(path, file, graph);
    if (sliceIdsForPath.length > 0) editOwners.push({ path, sliceIds: sliceIdsForPath });
    if (sliceIdsForPath.length > 1) overlaps.push({ path, editors: sliceIdsForPath });
  }
  return {
    editOwners: editOwners.sort(byPath),
    overlaps: overlaps.sort(byPath),
    dependencyEdges: graph.edges,
  };
}
