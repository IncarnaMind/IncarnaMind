import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type * as Y from "yjs";
import { CITATION_NODE, type CitationAttributes, type CitedWork } from "../../../core/api";
import { calculatedCitations, calculatedSources } from "../../../shared/figureRuns";
import { citationLocation } from "../../../shared/locations";
import {
  type NumberedCitation,
  numberCitations,
  numberedFigures,
  sideBySide,
  textBlockEdited,
} from "./citationNumbers";

/**
 * Citations side by side in the text, which a citation style (#289) writes as one:
 * "(Bowler et al., 2010; Oke, 1982)" or "[1, 3]". One on its own is a cluster too.
 */
export interface CitationCluster {
  members: NumberedCitation[];
  /** Names the cluster's works in order, to tell whether a formatted cluster still fits it. */
  signature: string;
}

/** Where a Citation is in its cluster, as its node view is told through a decoration. */
export interface ClusterPlace {
  /** The cluster's place in the Mind, from 0: its note's number is one more. */
  cluster: number;
  /** The Citation's place in the cluster, from 0. The first one draws the cluster. */
  member: number;
  size: number;
  signature: string;
}

/** What a style needs of a Citation: the Document it cites, where, and the version quoted. */
export function citedWorkOf(attributes: CitationAttributes): CitedWork {
  return {
    documentId: attributes.documentId ?? null,
    documentName: attributes.documentName ?? null,
    location: citationLocation(attributes),
    contentHash: attributes.contentHash ?? null,
  };
}

export const citationWorkSignature = (attributes: CitationAttributes) =>
  JSON.stringify([
    attributes.documentId,
    attributes.documentName,
    citationLocation(attributes),
    attributes.contentHash,
  ]);

/** The Mind's clusters, top to bottom. A footnote between two Citations parts them. */
export function clusterCitations(doc: ProseMirrorNode): CitationCluster[] {
  const clusters: { members: NumberedCitation[] }[] = [];
  let previous: NumberedCitation | undefined;
  for (const citation of numberCitations(doc)) {
    const last = clusters.at(-1);
    if (last && previous && sideBySide(doc, previous.pos, citation.pos)) {
      last.members.push(citation);
    } else {
      clusters.push({ members: [citation] });
    }
    previous = citation;
  }
  return clusters.map(({ members }) => ({
    members,
    signature: members.map((member) => citationWorkSignature(member.attributes)).join("|"),
  }));
}

/** The place a Citation's decorations give it in its cluster, or null without the plugin. */
export function clusterPlaceOf(decorations: readonly Decoration[]): ClusterPlace | null {
  for (const decoration of decorations) {
    const place: unknown = decoration.spec.clusterPlace;
    if (place) return place as ClusterPlace;
  }
  return null;
}

interface Clusters {
  clusters: readonly CitationCluster[];
  /** What decides whether the decorations must be drawn again (`shapeOf`). */
  shape: string;
  decorations: DecorationSet;
}

const clustersKey = new PluginKey<Clusters>("citationClusters");

/**
 * The attribute a Citation's place is drawn with, on its node view's outermost element:
 * "cluster:member:size:shape". The first Citation finds the others in its cluster by it.
 */
export const PLACE_ATTRIBUTE = "data-citation-cluster";

/** The marker of a cluster's member, in the editor's DOM, if it is drawn. */
export function memberMarker(
  root: HTMLElement,
  cluster: number,
  member: number,
): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    `[${PLACE_ATTRIBUTE}^="${cluster}:${member}:"] [data-testid="citation-chip"]`,
  );
}

/**
 * What the decorations draw: each cluster's works, and its Citations' checks, since the first
 * Citation draws the whole cluster, each work in its own check's colours.
 */
const shapeOf = (clusters: readonly CitationCluster[]) =>
  clusters
    .map(
      (cluster) =>
        `${cluster.signature}#${cluster.members.map((member) => member.attributes.check).join(",")}`,
    )
    .join("\n");

/** A short, stable stand-in for a cluster's shape in an attribute: changes with it. */
function hash(text: string): string {
  let value = 0;
  for (let index = 0; index < text.length; index++) {
    value = (Math.imul(31, value) + text.charCodeAt(index)) | 0;
  }
  return (value >>> 0).toString(36);
}

function clustersOf(doc: ProseMirrorNode): Clusters {
  const clusters = clusterCitations(doc);
  const decorations = DecorationSet.create(
    doc,
    clusters.flatMap((cluster, index) => {
      const drawn = hash(shapeOf([cluster]));
      return cluster.members.map((member, place) => {
        const clusterPlace: ClusterPlace = {
          cluster: index,
          member: place,
          size: cluster.members.length,
          signature: cluster.signature,
        };
        return Decoration.node(
          member.pos,
          member.pos + (doc.nodeAt(member.pos)?.nodeSize ?? 1),
          // In the attributes, not only the spec, so a change reaches the node view.
          { [PLACE_ATTRIBUTE]: `${index}:${place}:${cluster.members.length}:${drawn}` },
          { clusterPlace },
        );
      });
    }),
  );
  return { clusters, shape: shapeOf(clusters), decorations };
}

const citationsIn = (block: ProseMirrorNode | null) => {
  let count = 0;
  block?.forEach((child) => {
    if (child.type.name === CITATION_NODE) count++;
  });
  return count;
};

/** The editor's clusters as of its last change; empty without `CitationClusters`. */
export function citationClusters(state: EditorState): readonly CitationCluster[] {
  return clustersKey.getState(state)?.clusters ?? [];
}

export interface FormattingCluster {
  pos: number;
  works: CitedWork[];
  signature: string;
  citation: number | null;
  figure: string | null;
}

/** Includes figure inputs in the style's order without changing Citation decoration indices. */
export function formattingClusters(state: EditorState, doc: Y.Doc | null): FormattingCluster[] {
  const ordinary = citationClusters(state).map((cluster, index) => ({
    pos: cluster.members[0]?.pos ?? 0,
    works: cluster.members.map((member) => citedWorkOf(member.attributes)),
    signature: cluster.signature,
    citation: index,
    figure: null,
  }));
  const figures = numberedFigures(state).flatMap(({ pos, attributes }) => {
    const citations = calculatedCitations(calculatedSources(attributes, doc));
    return citations.length
      ? [
          {
            pos,
            works: citations.map(citedWorkOf),
            signature: citations.map(citationWorkSignature).join("|"),
            citation: null,
            figure: attributes.id,
          },
        ]
      : [];
  });
  return [...ordinary, ...figures].sort((a, b) => a.pos - b.pos);
}

/** The plugin behind `CitationClusters`, which keeps the clusters in the editor's state. */
export function citationClustersPlugin(): Plugin<Clusters> {
  return new Plugin<Clusters>({
    key: clustersKey,
    state: {
      init: (_config, state) => clustersOf(state.doc),
      apply: (tr, previous) => {
        if (!tr.docChanged) return previous;
        // Typing in a text block with fewer than two Citations can't join or part any:
        // they only move along. (Their positions in `clusters` aren't kept up to date.)
        const typedIn = textBlockEdited(tr);
        if (typedIn !== null && citationsIn(tr.doc.nodeAt(typedIn)) < 2) {
          return { ...previous, decorations: previous.decorations.map(tr.mapping, tr.doc) };
        }
        const next = clusterCitations(tr.doc);
        const shape = shapeOf(next);
        if (shape !== previous.shape) return clustersOf(tr.doc);
        return {
          clusters: next,
          shape,
          decorations: previous.decorations.map(tr.mapping, tr.doc),
        };
      },
    },
    props: {
      decorations: (state) => clustersKey.getState(state)?.decorations,
    },
  });
}

/**
 * Groups the Citations into clusters (see `clusterCitations`) and tells each node view its
 * place with a node decoration. Typing that leaves the clusters as they were only moves the
 * decorations along, so the Citations aren't drawn again at every keystroke.
 */
export const CitationClusters = Extension.create({
  name: "citationClusters",

  addProseMirrorPlugins() {
    return [citationClustersPlugin()];
  },
});
