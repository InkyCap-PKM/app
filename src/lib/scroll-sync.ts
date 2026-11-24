// Scrolls the two panes of a "Split with preview" together.
//
// Each pane joins a group with functions that convert between its scroll
// offsets and positions in the note's source (a line number with a fraction,
// as in `typst_pipeline/source_positions.rs`). When one pane scrolls it leads:
// its position is converted to an offset in the other, which follows.
//
// The compared point isn't the top of each pane but slides from the top edge
// to the bottom edge as a pane scrolls from start to end, so both panes reach
// their ends together and the middles line up in between.

/** One pane's scrolling element and its mapping to source positions. */
export interface ScrollSyncPane {
  scroller: HTMLElement;
  /** The element inside `scroller` whose size changes when the content does. */
  content: HTMLElement;
  /** The pane the other follows until the user scrolls one of them. */
  leadsByDefault: boolean;
  /** The source position shown at a distance from the top of the content.
   *  Null when nothing is laid out yet. */
  positionAt(offset: number): number | null;
  /** The reverse of `positionAt`. */
  offsetOf(position: number): number | null;
}

/** A pane's membership of its group. */
export interface ScrollSyncMember {
  /** Make the other pane follow this one from now on, without moving either. */
  lead(): void;
  /** Realign the panes after this one's content was replaced. */
  contentReplaced(): void;
  leave(): void;
}

/** How long after being moved to follow the other pane a pane's scroll events
 *  still count as caused by that move. */
const FOLLOW_MS = 200;

/** Any of these in a pane means the user is now scrolling that pane. */
const USER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

class Member {
  /** The pane's content is new and hasn't been aligned yet. */
  settling = false;
  private followingUntil = 0;
  private followedTo: number | null = null;
  constructor(readonly pane: ScrollSyncPane) {}

  stopFollowing() {
    this.settling = false;
    this.followingUntil = 0;
    this.followedTo = null;
  }

  /** Whether a scroll event now comes from following, not from the user. The
   *  offset is compared too, as a slow layout can delay the event. */
  isFollowing() {
    return (
      this.settling ||
      performance.now() < this.followingUntil ||
      (this.followedTo !== null && Math.abs(this.pane.scroller.scrollTop - this.followedTo) < 2)
    );
  }

  /** The pane's source position at the sliding compared point. */
  position(): number | null {
    const { scrollTop, scrollHeight, clientHeight } = this.pane.scroller;
    const range = scrollHeight - clientHeight;
    if (clientHeight === 0 || range <= 0) return null;
    return this.pane.positionAt((scrollTop / range) * scrollHeight);
  }

  scrollTo(position: number) {
    const { scroller } = this.pane;
    const { scrollTop, scrollHeight, clientHeight } = scroller;
    const range = scrollHeight - clientHeight;
    if (clientHeight === 0 || range <= 0) return;
    const offset = this.pane.offsetOf(position);
    if (offset === null) return;
    const target = Math.max(0, Math.min(range, (offset / scrollHeight) * range));
    this.followingUntil = performance.now() + FOLLOW_MS;
    this.followedTo = target;
    if (Math.abs(target - scrollTop) >= 1) scroller.scrollTop = target;
  }
}

class Group {
  readonly members = new Set<Member>();
  private lastLeader: Member | null = null;
  private frame = 0;

  leader(): Member | null {
    if (this.lastLeader) return this.lastLeader;
    const all = [...this.members];
    return all.find((m) => m.pane.leadsByDefault) ?? all[0] ?? null;
  }

  setLeader(member: Member) {
    member.stopFollowing();
    this.lastLeader = member;
  }

  /** Bring every other pane to the leader's position on the next frame. */
  schedule() {
    if (this.frame || this.members.size < 2) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const leader = this.leader();
      const position = leader?.position() ?? null;
      for (const member of this.members) {
        member.settling = false;
        if (member !== leader && position !== null) member.scrollTo(position);
      }
    });
  }

  remove(member: Member) {
    this.members.delete(member);
    if (this.lastLeader === member) this.lastLeader = null;
    if (this.members.size === 0) cancelAnimationFrame(this.frame);
  }
}

const groups = new Map<string, Group>();

/** Add a pane to the group named `key`; panes in one group scroll together. */
export function joinScrollSync(key: string, pane: ScrollSyncPane): ScrollSyncMember {
  let group = groups.get(key);
  if (!group) groups.set(key, (group = new Group()));
  const ownGroup = group;
  const member = new Member(pane);
  ownGroup.members.add(member);

  const onScroll = () => {
    if (ownGroup.leader() !== member) {
      if (member.isFollowing()) return;
      ownGroup.setLeader(member);
    }
    ownGroup.schedule();
  };
  const onUserInput = () => ownGroup.setLeader(member);
  pane.scroller.addEventListener("scroll", onScroll, { passive: true });
  for (const type of USER_INPUT) {
    pane.scroller.addEventListener(type, onUserInput, { passive: true, capture: true });
  }

  // Resizing a pane, zooming it, or content laying out late (images, lines the
  // editor had only estimated) moves what is in view.
  const resize = new ResizeObserver(() => ownGroup.schedule());
  resize.observe(pane.scroller);
  resize.observe(pane.content);

  function realign() {
    member.settling = ownGroup.leader() !== member;
    // A frame later than a pane's own restoring of its remembered scroll.
    requestAnimationFrame(() => {
      if (ownGroup.members.has(member)) ownGroup.schedule();
    });
  }
  realign();

  return {
    lead: () => ownGroup.setLeader(member),
    contentReplaced: realign,
    leave() {
      pane.scroller.removeEventListener("scroll", onScroll);
      for (const type of USER_INPUT) {
        pane.scroller.removeEventListener(type, onUserInput, { capture: true });
      }
      resize.disconnect();
      ownGroup.remove(member);
      if (ownGroup.members.size === 0 && groups.get(key) === ownGroup) groups.delete(key);
    },
  };
}
