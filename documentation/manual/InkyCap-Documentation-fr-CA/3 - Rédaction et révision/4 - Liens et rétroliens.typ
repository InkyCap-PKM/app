#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Liens et rétroliens",
  description: "Comment relier les notes avec des liens wiki, pointer vers un titre, utiliser des alias, suivre des liens externes et lire les rétroliens automatiques que chaque note accumule.",
  tags: ("documentation",),
)

= Liens et rétroliens

Plutôt que de classer vos notes dans des dossiers et de les oublier, reliez entre elles les idées apparentées. InkyCap suit ces connexions dans les deux sens. \


== Créer un lien vers une autre note

La façon la plus rapide de relier des notes est de taper deux crochets :
```typ
[[
```

Dès que vous tapez `[[`, un petit sélecteur de recherche s'ouvre. Commencez à taper une partie du nom d'une note et InkyCap fait une correspondance approximative parmi vos notes à mesure (il cherche dans les fichiers `.typ` de votre boîte de notes). Une recherche vide liste toutes les notes.

Pour choisir une note :

- Utilisez *Flèche haut* et *Flèche bas* pour parcourir la liste.
- Appuyez sur *Entrée* pour insérer le lien.

Quand vous choisissez une note, InkyCap complète le lien wiki de l'éditeur visuel avec `]]` et écrit le véritable balisage Typst sous-jacent à votre place. Vous n'avez pas à le taper vous-même, mais voici à quoi il ressemble :

```typ
#wikilink("Mon autre note")
```

Le texte entre les guillemets est le nom de fichier de la note cible (sans son extension).

#callout("tip")[ Vous pouvez aussi sélectionner du texte d'abord, puis taper `[[` pour envelopper votre sélection dans un lien. Le lien wiki complet ressemble à `[[nomdefichier]]` dans l'éditeur visuel ]

=== Lier vers une note qui n'existe pas encore

Vous n'avez pas besoin de créer une note avant de pouvoir la lier. Si le nom que vous tapez ne correspond à aucune note existante, le sélecteur affiche une rangée supplémentaire au bas :

- *Create: {name}* insère le lien tout de suite ; la note elle-même est créée la première fois que vous cliquez pour l'atteindre.

C'est une façon naturelle d'écrire : #highlight(fill: rgb("#c8f0c8"))[notez un lien vers une idée que vous n'avez pas encore étoffée, continuez d'écrire et remplissez cette note plus tard]. Tant que la note n'existe pas, InkyCap marque le lien comme *non résolu*, de sorte que vous voyez d'un coup d'œil quels liens ont encore besoin d'une destination. Un lien non résolu reçoit un style distinct dans l'éditeur visuel (et une commande « créer » à icône pointillée dans le panneau Liens, décrite plus bas).

#callout("note")[ Les liens non résolus ne sont montrés que comme un doux repère visuel. Il n'y a ni erreur ni soulignement d'avertissement pour eux ; ce sont un rappel, pas une faute. ]

== Afficher un texte différent sur un lien

Parfois, le nom de fichier de la note n'est pas la formulation que vous voulez dans votre phrase. Vous pouvez donner à un lien son propre texte d'affichage. Dans le balisage sous-jacent, c'est l'option `display:` :

```typ
#wikilink("Théorie de l'esprit", display: "comment nous modélisons l'esprit des autres")
```

Le lien pointe toujours vers la même note, mais votre phrase se lit naturellement.

== Lier vers un titre précis

Un lien peut sauter non seulement vers une note, mais vers une section particulière à l'intérieur de celle-ci. Utilisez un double deux-points après le nom de la note pour choisir un titre.

Après avoir choisi une note dans le sélecteur, vous avez deux façons d'entrer en *mode titre* :

- Tapez `::` après le nom de la note (par exemple `[[Ma note::`), ou
- Appuyez sur *Tab* sur une note surlignée dans la liste.

Le sélecteur affiche alors les titres de cette note, en retrait selon le niveau, et un pied de page vous rappelle : « Select a heading to link directly to that section. » Choisissez-en un, et InkyCap insère un lien qui amène le lecteur à ce titre exact et le fait défiler à l'écran. Le balisage sous-jacent utilise l'option `label:` :

```typ
#wikilink("Ma note", label: "la-section")
```

Les indications du pied de page dans le sélecteur vous guident à travers cela :

- « Type :: after a note name to link to a heading »
- « …or press Tab on a page above to pick from its headings »

#callout("tip", title: "Pour les utilisateurs de Typst")[ Un lien wiki est une fonction Typst : `#wikilink(name, display: none, label: none)`. Le `name` positionnel est le radical du fichier ; `display:` remplace le texte rendu ; `label:` ancre vers un titre. Chaque appel émet aussi des métadonnées `<inkycap-link>` interrogeables (`(target, from: "body")`) qui sont l'unique source à partir de laquelle les rétroliens sont calculés. Quand vous ciblez un titre, InkyCap réutilise l'étiquette existante du titre s'il en a une, sinon il transforme le texte du titre en radical (slug) et insère un `<label>` dans la note cible pour que l'ancre soit stable. C'est pourquoi, dans la forme à crochets de l'éditeur visuel, vous voyez le *slug* de l'étiquette (`Ma note::la-section`) plutôt que le texte humain du titre ; le slug est la source `label:` modifiable. ]

== Suivre les liens en lisant et en écrivant

Les liens wiki sont cliquables partout où ils apparaissent :

- *Cliquez* sur un lien pour ouvrir la note dans votre onglet courant. Si la note n'existe pas encore, le clic la crée.
- *Ctrl/Cmd+clic* ou *clic du milieu* pour l'ouvrir plutôt dans un nouvel onglet.
- *Clic droit* pour plus d'options : *Edit in new tab*, *Open in Journal Scroll tab* et *Open in Mycelial View tab*.

Ils se comportent de la même façon partout où un lien peut apparaître : dans le corps d'une note, à l'intérieur des callouts et des citations, dans l'éditeur de propriétés et dans le #wikilink("4 - Rouleau de journal").

Pour en savoir plus sur la façon dont l'éditeur rend les liens quand vous déplacez votre curseur, voir #wikilink("2 - Modifier des notes").

== Alias : laisser une note répondre à plusieurs noms

Souvent, une note mérite plus d'un nom. Une note intitulée « Apprentissage automatique » pourrait aussi être appelée « AA ». Les alias permettent qu'une note soit trouvée et liée par n'importe lequel de ses noms de rechange.

Vous définissez les alias comme une propriété de note (vue dans #wikilink("6 - Propriétés des notes")). Dans la valeur de la propriété, listez les noms de rechange séparés par des virgules (par exemple `AA, Apprentissage automatique`). InkyCap découpe cela sur les virgules, de sorte que chacun devient son propre alias.

Une fois définis, les alias alimentent le sélecteur de liens wiki. Quand vous tapez un alias, le sélecteur montre la vraie note avec un indice atténué du genre *via alias « AA »*, et la choisir insère un lien qui *affiche* le texte de l'alias tout en pointant vers la bonne note :

```typ
#wikilink("Apprentissage automatique", display: "AA")
```

#callout("important")[ Les alias vous aident à *trouver et étiqueter* un lien dans le sélecteur, et ils définissent le texte affiché. Ils ne créent pas, à eux seuls, un rétrolien sous un nom inventé : les rétroliens sont résolus par le vrai nom de fichier de la note. Un lien s'enregistrera comme rétrolien tant qu'il pointe vers un vrai fichier de note. ]

== Liens externes : le web, le courriel, les fichiers

Les liens peuvent pointer hors de votre boîte de notes. Vous pouvez lier vers des sites web, une adresse de courriel ou un fichier sur votre ordinateur.

La palette de commandes `/` propose deux insertions toutes prêtes :

- *Wikilink* (sous « InkyCap ») insère un lien de note.
- *Link* (sous « Insert ») insère un lien externe avec son propre texte :

```typ
#link("https://example.com")[texte convivial]
```

Dans l'éditeur source, une adresse web nue ou un `#link(...)` devient cliquable avec *Ctrl/Cmd+clic*. Maintenez la touche de modification et survolez : InkyCap affiche une infobulle « Ctrl/Cmd+Click to follow link » avec un curseur pointeur.

La destination d'un lien dépend de ce qu'il est :

- Les adresses avec un schéma (`https`, `http`, `mailto:`, `zotero://`, et autres) s'ouvrent dans le gestionnaire par défaut de votre système d'exploitation (votre navigateur, votre application de courriel ou votre gestionnaire de références).
- Un chemin qui commence par `/`, (ou, sous Windows, une lettre de lecteur comme `C:\`), est traité comme un fichier à l'intérieur de votre boîte de notes et ouvert avec son application par défaut.


== Les rétroliens comptent : le modèle réciproque

Quand vous mentionnez (liez) une note à l'intérieur d'une autre, deux choses se produisent :

+ Cliquer sur le lien vous amène directement à l'autre note (et la crée pour vous si elle n'existe pas encore).
+ L'autre note gagne automatiquement un *rétrolien*, un enregistrement qui dit « cette note pointe vers moi ».

InkyCap garde synchronisés les deux bouts de chaque connexion.

Ce modèle réciproque est ce qui permet à votre boîte de notes de devenir un réseau connecté plutôt qu'un tas de fichiers épars. Plus vous liez, plus vos notes s'illuminent des nouveaux contextes dans lesquels vous les avez placées. Avec le temps, vous pouvez bâtir des milliers de connexions, que la #wikilink("5 - Vue mycélienne") visualisera en concepts que vos notes elles-mêmes vous suggèrent d'explorer.

Vous lisez ces connexions dans l'onglet *Liens* du panneau de droite. Il comporte trois sections repliables, chacune avec un compteur et un état ouvert/fermé mémorisé :

+ *Les liens entrants* sont les notes qui pointent *vers* la note que vous regardez (ses _rétroliens_). Déployez une rangée pour prévisualiser la ligne où le lien apparaît, avec un contexte environnant optionnel ; double-cliquez sur une rangée pour basculer cet aperçu.
+ *Les liens sortants* sont les notes vers lesquelles votre note active pointe. Les liens vers des notes qui n'existent pas encore apparaissent comme *non résolus*, avec une icône de fichier en pointillé et un bouton *create* ; cliquer sur la rangée ou le bouton crée la note manquante sur-le-champ.
+ *Les liens wiki possibles* sont des notes qui *mentionnent le nom de cette note en texte clair* mais ne l'ont pas encore vraiment liée. C'est un doux coup de coude vers des connexions que vous avez peut-être écrites sans vous en rendre compte.

Le panneau vous donne quelques façons de retrouver des notes dans une liste chargée :

- *Trier les liens* par nom, date de modification ou date de création, en ordre croissant ou décroissant. Les entrées non résolues se trient toujours au bas.
- *Déployer les aperçus / Replier les aperçus* affiche ou masque les lignes de contexte de chaque rangée d'un coup.
- *Filtrer les liens par nom* avec une boîte de recherche (« Search within links... ») qui restreint les listes. Elle prend en charge toute la syntaxe de recherche (phrases entre guillemets, `AND`/`OR`/`NOT` et filtres comme `tag:`, `file:`, `path:` et `property:`) limitée aux seuls liens de cette note. (Pour en savoir plus sur les étiquettes, voir #wikilink("5 - Étiquettes").)

#callout("note")[ Quand vous ouvrez une grande boîte de notes pour la première fois, InkyCap construit son index de liens en arrière-plan. Le panneau Liens peut paraître vide un instant et se remplira automatiquement une fois cela terminé. ]

=== Les liens survivent au renommage et au déplacement

Vous pouvez renommer ou réorganiser librement sans briser les connexions de vos liens. Le réglage *Auto-update links on rename* (« Automatically update wikilinks when a file is renamed ») est activé par défaut. Quand vous renommez une note, InkyCap réécrit chaque lien qui pointait vers l'ancien nom (sous la forme à crochets comme sous la forme complète) pour qu'ils suivent tous la note vers son nouveau nom.

=== Pour les utilisateurs de Typst

#callout("tip", title: "Utilisateurs Typst avancés")[ Les liens et rétroliens passent par des métadonnées natives de Typst. Les liens wiki de corps et les valeurs `link-ref` de métadonnées émettent tous deux l'étiquette `<inkycap-link>` (`from: "body"` contre `from: "metadata"`), et les rétroliens sont l'inverse de ces arêtes. La résolution associe une cible à un fichier par *radical insensible à la casse* ; quand plusieurs fichiers correspondent, le chemin le plus court l'emporte, et les suffixes de titre (`Note::titre`) sont d'abord retirés. Une valeur `link-ref(name)` permet à une propriété typée dans `#note(...)` de pointer vers une autre note tout en produisant un vrai rétrolien. Le fait que les liens wiki se rendent en mode lecture et à l'exportation est régi par le réglage *Show inline wikilinks* (activé par défaut), qui correspond à un état `#set-notebox(show-inline-wikilinks: …)` que vous pouvez aussi remplacer par document. Quand vous exportez une collection sous forme de livre, une option *Wikilinks* distincte vous permet de résoudre les liens vers les chapitres du livre, de les garder pointés vers les fichiers source, ou de les réduire en texte clair. ]
\

== Pages connexes

- #wikilink("6 - Propriétés des notes"). Là où vous définissez les alias d'une note.
- #wikilink("2 - Modifier des notes"). Comment les liens se rendent à mesure que vous écrivez.
- #wikilink("5 - Vue mycélienne"). Voir vos liens comme une carte visuelle des connexions.
- #wikilink("5 - Étiquettes"). Une autre façon de regrouper et retrouver des notes apparentées.
- #wikilink("4 - Rouleau de journal"). Une surface de lecture continue où les liens restent vivants.
