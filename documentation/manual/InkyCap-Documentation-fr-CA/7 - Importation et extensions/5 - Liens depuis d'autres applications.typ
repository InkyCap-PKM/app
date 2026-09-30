#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Liens depuis d'autres applications",
  description: "Comment ouvrir une note depuis d'autres applications avec un lien inkycap:// : copier un lien, sa forme, et ce qui se passe quand vous cliquez dessus.",
  tags: ("documentation",),
)

= Liens depuis d'autres applications

Un *lien InkyCap* ouvre une note ou une collection précise dans InkyCap depuis n'importe où sur votre ordinateur : une entrée d'agenda, un brouillon de courriel, un gestionnaire de tâches, les notes d'une autre application ou un script. Un clic sur un tel lien amène InkyCap au premier plan avec cette note ouverte, en démarrant d'abord InkyCap s'il n'est pas lancé.

Les liens InkyCap commencent par `inkycap://`. Ils ne fonctionnent que sur votre propre ordinateur et n'envoient rien sur Internet.

== Copier un lien

Faites un clic droit sur une note ou une collection et choisissez *Copier le lien InkyCap*. Le lien est copié dans votre presse-papiers, prêt à être collé où vous voulez. La commande se trouve dans :

- l'arborescence des fichiers, pour les notes et les collections;
- la liste des *Collections*;
- le menu *Options de l'onglet*, au bout de la barre d'onglets, pour la note ou la collection de l'onglet actif;
- le panneau *Plan*, où *Copier le lien InkyCap vers ce titre* crée un lien qui ouvre la note à la hauteur de ce titre.

== Ce qui se passe quand vous cliquez sur un lien

- *La boîte de notes est ouverte dans une fenêtre :* cette fenêtre passe au premier plan et la note s'ouvre dans un nouvel onglet, à côté de ce sur quoi vous travailliez.
- *La boîte de notes n'est ouverte nulle part :* InkyCap vous demande avant de l'ouvrir, puis l'ouvre dans une nouvelle fenêtre pour ne pas toucher à vos onglets actuels.
- *InkyCap n'est pas lancé :* InkyCap démarre et ouvre directement la boîte de notes du lien, sans rien demander.
- *La note n'existe plus :* InkyCap affiche un court message et ne fait rien d'autre. Contrairement à un #wikilink("4 - Liens et rétroliens", display: "wikilink"), un lien venu de l'extérieur d'InkyCap ne crée jamais de note.

#callout("note")[Un lien désigne sa boîte de notes par le nom affiché sous *Gérer les boîtes de notes*; renommer une boîte de notes empêche donc ses liens existants de fonctionner. Les liens ne peuvent ouvrir que les boîtes de notes listées à cet endroit; un lien ne peut jamais faire ouvrir à InkyCap un dossier que vous n'avez pas ajouté vous-même.]

== Faire des liens d'une boîte de notes à une autre

Les wikilinks n'atteignent que les notes de la même boîte de notes. Pour faire un lien vers une note d'une _autre_ boîte de notes, collez un lien InkyCap dans un lien Typst ordinaire :

```typst
#link("inkycap://open?notebox=Professionnel&file=Liste%20de%20lecture.collection")[Ma liste de lecture]
```

Un clic sur ce lien le suit à l'intérieur d'InkyCap, comme décrit plus haut.

== La forme d'un lien

```text
inkycap://open?notebox=Professionnel&file=1%20%C3%89ph%C3%A9m%C3%A8res%2FBrouillon.typ
inkycap://open?notebox=Professionnel&file=Brouillon.typ&heading=M%C3%A9thode
inkycap://open?notebox=Professionnel&zid=20260916T0930
inkycap://search?notebox=Professionnel&query=hydrologie
```

Vous pouvez écrire des liens à la main ou les construire dans un script. Chaque lien a un verbe (`open` ou `search`) et quelques valeurs :

#table(
  columns: 3,
  table.header[*Valeur*][*Avec*][*Signification*],
  [`notebox`], [les deux], [Le nom de la boîte de notes sous *Gérer les boîtes de notes*. Toujours requis.],
  [`file`], [`open`], [La note ou la collection, sous forme de chemin dans la boîte de notes, avec `/` entre les dossiers. On peut omettre `.typ` à la fin du nom d'une note.],
  [`zid`], [`open`], [La propriété `zid` de la note, utilisée à la place de `file`. Un lien par zid continue de fonctionner quand la note est renommée ou déplacée.],
  [`heading`], [`open`], [Facultatif. Le texte d'un titre, ou son étiquette, où faire défiler la note.],
  [`query`], [`search`], [Le texte à chercher dans le panneau *Recherche* de la boîte de notes.],
)

Les espaces et autres caractères spéciaux dans les valeurs doivent s'écrire comme dans une adresse Web : une espace devient `%20`, une `/` à l'intérieur d'une valeur devient `%2F`, `&` devient `%26` et `#` devient `%23`; les lettres accentuées sont aussi encodées (`é` devient `%C3%A9`). Les liens qu'InkyCap copie pour vous le font déjà. Si un lien donne à la fois `file` et `zid`, c'est le `zid` qui compte.

Un lien peut seulement ouvrir des notes et des collections, ou lancer une recherche. Il ne modifie, ne crée ni ne supprime jamais rien, et un lien mal écrit est ignoré.

== Quand un lien ne fait rien

Pour qu'un clic sur un lien fonctionne, votre ordinateur doit savoir qu'InkyCap s'occupe des liens `inkycap://`. Les installateurs d'InkyCap (pour Linux, Windows et macOS) et le Flatpak s'en chargent. L'AppImage le fait elle-même à chaque démarrage : si vous déplacez le fichier AppImage, lancez-le une fois depuis son nouvel emplacement. Lancer une AppImage en fait aussi la copie d'InkyCap qui reçoit les liens, même si une autre copie est installée.

Sous macOS, InkyCap doit se trouver dans votre dossier *Applications* pour que les liens l'atteignent.
