import { Component, createSignal, createMemo, For } from "solid-js";
import {
  // Science
  Atom,
  Dna,
  FlaskConical,
  Magnet,
  Microscope,
  Telescope,
  Radiation,
  Omega,
  Pi,
  Sigma,
  Variable,
  Infinity,
  // User's list
  PencilRuler,
  Section,
  Pilcrow,
  NotepadText,
  ClipboardCheck,
  BookPlus,
  Brush,
  CalendarHeart,
  CalendarPlus,
  AlarmClock,
  Anvil,
  Bike,
  Plane,
  TrafficCone,
  Sailboat,
  MapPinPen,
  Podcast,
  Radio,
  Heart,
  MessageCircle,
  Bot,
  HatGlasses,
  Handshake,
  Box,
  Asterisk,
  DraftingCompass,
  Calculator,
  LockKeyhole,
  Waypoints,
  Leaf,
  Camera,
  Image,
  Film,
  Binoculars,
  Earth,
  Utensils,
  Flower,
  Sprout,
  Mountain,
  TreePine,
  Music,
  Drama,
  RadioTower,
  Star,
  MonitorPlay,
  Inbox,
  Archive,
  Paperclip,
  Skull,
  Ghost,
  BookOpen,
  Apple,
  Coffee,
  Gem,
  ThumbsDown,
  ThumbsUp,
  Smile,
  Frown,
  Meh,
  Mic,
  MicVocal,
  AudioLines,
  AudioWaveform,
  Piano,
  Headphones,
  Headset,
  HeartPulse,
  Palette,
  Monitor,
  Rocket,
  Network,
  Blend,
  Binary,
  Database,
  Computer,
  House,
  Hotel,
  Castle,
  Landmark,
  University,
  Bird,
  Bug,
  Cat,
  Dog,
  Fish,
  Origami,
  Panda,
  Rabbit,
  Rat,
  Shell,
  Snail,
  Turtle,
  User,
  MapPinned,
  BookUser,
  Gift,
  Glasses,
  Cake,
  Car,
  Trophy,
  BookOpenText,
  ClipboardList,
  Quote,
  Notebook,
  Clock3,
  PocketKnife,
  BriefcaseBusiness,
  Cloud,
  Umbrella,
  Zap,
  AtSign,
  BookText,
  FileCode,
  FileHeart,
  FilePlus2,
  FilePenLine,
  FileText,
  FileQuestionMark,
  File,
  Folder,
  FolderOpen,
  FolderPen,
  PersonStanding,
  Speech,
  // Added icons
  Brain,
  TramFront,
  Bus,
  Rainbow,
  Footprints,
  Road,
  TrainFrontTunnel,
  Globe,
  Briefcase,
  Anchor,
  TrainTrack,
  Hexagon,
  Blocks,
  CodeXml,
  Boxes,
  Orbit,
  Hammer,
} from "lucide-solid";
import type { Component as SolidComponent } from "solid-js";

interface IconEntry {
  name: string;
  component: SolidComponent<{ size?: number; class?: string }>;
}

const CURATED_ICONS: IconEntry[] = [
  // Science
  { name: "atom", component: Atom },
  { name: "brain", component: Brain },
  { name: "dna", component: Dna },
  { name: "flask-conical", component: FlaskConical },
  { name: "magnet", component: Magnet },
  { name: "microscope", component: Microscope },
  { name: "telescope", component: Telescope },
  { name: "radiation", component: Radiation },
  { name: "omega", component: Omega },
  { name: "pi", component: Pi },
  { name: "sigma", component: Sigma },
  { name: "variable", component: Variable },
  { name: "infinity", component: Infinity },
  // Files & folders
  { name: "file", component: File },
  { name: "file-text", component: FileText },
  { name: "file-code", component: FileCode },
  { name: "file-heart", component: FileHeart },
  { name: "file-plus-2", component: FilePlus2 },
  { name: "file-pen-line", component: FilePenLine },
  { name: "file-question-mark", component: FileQuestionMark },
  { name: "folder", component: Folder },
  { name: "folder-open", component: FolderOpen },
  { name: "folder-pen", component: FolderPen },
  // Writing & notes
  { name: "pencil-ruler", component: PencilRuler },
  { name: "section", component: Section },
  { name: "pilcrow", component: Pilcrow },
  { name: "notepad-text", component: NotepadText },
  { name: "clipboard-check", component: ClipboardCheck },
  { name: "book-plus", component: BookPlus },
  { name: "book-open-text", component: BookOpenText },
  { name: "book-text", component: BookText },
  { name: "notebook", component: Notebook },
  { name: "clipboard-list", component: ClipboardList },
  { name: "quote", component: Quote },
  { name: "brush", component: Brush },
  { name: "palette", component: Palette },
  // Calendar & time
  { name: "calendar-heart", component: CalendarHeart },
  { name: "calendar-plus", component: CalendarPlus },
  { name: "alarm-clock", component: AlarmClock },
  { name: "clock-3", component: Clock3 },
  // Transport & objects
  { name: "anvil", component: Anvil },
  { name: "bike", component: Bike },
  { name: "bus", component: Bus },
  { name: "plane", component: Plane },
  { name: "tram-front", component: TramFront },
  { name: "train", component: TrainFrontTunnel },
  { name: "train-track", component: TrainTrack },
  { name: "traffic-cone", component: TrafficCone },
  { name: "sailboat", component: Sailboat },
  { name: "car", component: Car },
  { name: "road", component: Road },
  { name: "footprints", component: Footprints },
  // Maps & communication
  { name: "map-pin-pen", component: MapPinPen },
  { name: "podcast", component: Podcast },
  { name: "radio", component: Radio },
  { name: "heart", component: Heart },
  { name: "heart-pulse", component: HeartPulse },
  { name: "message-circle", component: MessageCircle },
  { name: "bot", component: Bot },
  { name: "hat-glasses", component: HatGlasses },
  { name: "handshake", component: Handshake },
  // Shapes & math
  { name: "box", component: Box },
  { name: "boxes", component: Boxes },
  { name: "blocks", component: Blocks },
  { name: "hexagon", component: Hexagon },
  { name: "asterisk", component: Asterisk },
  { name: "drafting-compass", component: DraftingCompass },
  { name: "calculator", component: Calculator },
  { name: "lock-keyhole", component: LockKeyhole },
  { name: "waypoints", component: Waypoints },
  { name: "orbit", component: Orbit },
  // Nature
  { name: "leaf", component: Leaf },
  { name: "flower", component: Flower },
  { name: "sprout", component: Sprout },
  { name: "mountain", component: Mountain },
  { name: "tree-pine", component: TreePine },
  { name: "rainbow", component: Rainbow },
  { name: "earth", component: Earth },
  { name: "globe", component: Globe },
  // Media
  { name: "camera", component: Camera },
  { name: "image", component: Image },
  { name: "film", component: Film },
  { name: "binoculars", component: Binoculars },
  { name: "music", component: Music },
  { name: "drama", component: Drama },
  { name: "radio-tower", component: RadioTower },
  { name: "monitor-play", component: MonitorPlay },
  { name: "mic", component: Mic },
  { name: "mic-vocal", component: MicVocal },
  { name: "audio-lines", component: AudioLines },
  { name: "audio-waveform", component: AudioWaveform },
  { name: "piano", component: Piano },
  { name: "headphones", component: Headphones },
  { name: "headset", component: Headset },
  // General
  { name: "star", component: Star },
  { name: "inbox", component: Inbox },
  { name: "archive", component: Archive },
  { name: "paperclip", component: Paperclip },
  { name: "skull", component: Skull },
  { name: "ghost", component: Ghost },
  { name: "book-open", component: BookOpen },
  { name: "apple", component: Apple },
  { name: "coffee", component: Coffee },
  { name: "gem", component: Gem },
  { name: "utensils", component: Utensils },
  { name: "cake", component: Cake },
  { name: "gift", component: Gift },
  { name: "trophy", component: Trophy },
  { name: "pocket-knife", component: PocketKnife },
  { name: "hammer", component: Hammer },
  { name: "anchor", component: Anchor },
  { name: "briefcase", component: Briefcase },
  { name: "briefcase-business", component: BriefcaseBusiness },
  { name: "cloud", component: Cloud },
  { name: "umbrella", component: Umbrella },
  { name: "zap", component: Zap },
  { name: "at-sign", component: AtSign },
  // Reactions
  { name: "thumbs-down", component: ThumbsDown },
  { name: "thumbs-up", component: ThumbsUp },
  { name: "smile", component: Smile },
  { name: "frown", component: Frown },
  { name: "meh", component: Meh },
  // Tech
  { name: "monitor", component: Monitor },
  { name: "computer", component: Computer },
  { name: "code-xml", component: CodeXml },
  { name: "rocket", component: Rocket },
  { name: "network", component: Network },
  { name: "blend", component: Blend },
  { name: "binary", component: Binary },
  { name: "database", component: Database },
  // Buildings
  { name: "house", component: House },
  { name: "hotel", component: Hotel },
  { name: "castle", component: Castle },
  { name: "landmark", component: Landmark },
  { name: "university", component: University },
  // Animals
  { name: "bird", component: Bird },
  { name: "bug", component: Bug },
  { name: "cat", component: Cat },
  { name: "dog", component: Dog },
  { name: "fish", component: Fish },
  { name: "origami", component: Origami },
  { name: "panda", component: Panda },
  { name: "rabbit", component: Rabbit },
  { name: "rat", component: Rat },
  { name: "shell", component: Shell },
  { name: "snail", component: Snail },
  { name: "turtle", component: Turtle },
  // People & identity
  { name: "user", component: User },
  { name: "person-standing", component: PersonStanding },
  { name: "speech", component: Speech },
  { name: "book-user", component: BookUser },
  { name: "map-pinned", component: MapPinned },
  { name: "glasses", component: Glasses },
];

export const LUCIDE_ICON_MAP: Record<string, SolidComponent<{ size?: number; class?: string }>> =
  Object.fromEntries(CURATED_ICONS.map((e) => [e.name, e.component]));

interface LucideIconPickerProps {
  value: string;
  onSelect: (value: string) => void;
}

const LucideIconPicker: Component<LucideIconPickerProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const [dropdownPos, setDropdownPos] = createSignal({ top: 0, left: 0 });
  let triggerRef: HTMLButtonElement | undefined;

  const filtered = createMemo(() => {
    const q = filter().toLowerCase();
    if (!q) return CURATED_ICONS;
    return CURATED_ICONS.filter((e) => e.name.includes(q));
  });

  const selectedName = () => {
    if (!props.value.startsWith("lucide:")) return null;
    return props.value.slice("lucide:".length);
  };

  function toggleOpen() {
    if (!open() && triggerRef) {
      const rect = triggerRef.getBoundingClientRect();
      const dropW = 260;
      const dropH = 340;
      let left = rect.left;
      let top = rect.bottom + 4;
      if (left + dropW > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - dropW - 8);
      }
      if (top + dropH > window.innerHeight - 8) {
        top = Math.max(8, rect.top - dropH - 4);
      }
      setDropdownPos({ top, left });
    }
    setOpen((v) => !v);
  }

  return (
    <div class="icon-picker">
      <button
        class="icon-picker__trigger"
        type="button"
        ref={triggerRef}
        onClick={toggleOpen}
        title="Pick an icon"
      >
        {selectedName()
          ? (() => {
              const Comp = LUCIDE_ICON_MAP[selectedName()!];
              return Comp ? <Comp size={16} /> : "Pick icon";
            })()
          : "Pick icon"}
      </button>
      {open() && (
        <div
          class="icon-picker__dropdown"
          style={{
            position: "fixed",
            top: `${dropdownPos().top}px`,
            left: `${dropdownPos().left}px`,
          }}
        >
          <input
            class="icon-picker__search"
            type="text"
            placeholder="Filter icons..."
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            autofocus
          />
          <div class="icon-picker__grid">
            <For each={filtered()}>
              {(entry) => (
                <button
                  class={`icon-picker__item${selectedName() === entry.name ? " icon-picker__item--selected" : ""}`}
                  type="button"
                  title={entry.name}
                  onClick={() => {
                    props.onSelect(`lucide:${entry.name}`);
                    setOpen(false);
                    setFilter("");
                  }}
                >
                  <entry.component size={16} />
                </button>
              )}
            </For>
          </div>
          <button
            class="icon-picker__clear"
            type="button"
            onClick={() => {
              props.onSelect("");
              setOpen(false);
              setFilter("");
            }}
          >
            Clear icon
          </button>
        </div>
      )}
    </div>
  );
};

export default LucideIconPicker;
