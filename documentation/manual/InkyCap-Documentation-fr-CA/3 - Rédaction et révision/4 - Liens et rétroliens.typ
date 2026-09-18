#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Liens et rétroliens",
  description: "Comment relier les notes avec des liens wiki, pointer vers un titre, utiliser des alias, suivre des liens externes et lire les rétroliens automatiques que chaque note accumule.",
  tags: ("documentation",),
)

= Liens et rétroliens

Reliez entre elles les idées apparentées pour organiser vos idées ou vos informations en un graphe de connaissances. InkyCap suit ces connexions dans les deux sens. InkyCap rend les liens entre les notes facilement visibles dans différents contextes pendant que vous travaillez avec vos notes. Ils sont aussi précieux pour tirer parti d'autres fonctionnalités d'InkyCap, comme la Vue mycélienne. \


== Créer un lien vers une autre note

La façon la plus rapide de relier des notes est d'utiliser le raccourci InkyCap qui consiste à taper deux crochets :
```typ
[[
```

Dès que vous tapez `[[`, un petit sélecteur de recherche s'ouvre. Commencez à taper une partie du nom d'une note et InkyCap fait une correspondance approximative parmi vos notes à mesure (il cherche dans les fichiers `.typ` de votre boîte de notes). Une recherche vide liste toutes les notes.

Pour choisir une note :

- Utilisez *Flèche haut* et *Flèche bas* pour parcourir la liste.
- Appuyez sur *Entrée* pour insérer le lien.
- Ou utilisez la souris pour choisir dans la liste.

Quand vous choisissez une note, InkyCap complète le lien wiki de l'éditeur visuel avec `]]` et écrit le véritable balisage Typst sous-jacent à votre place. Vous n'avez pas à le taper vous-même, mais voici à quoi il ressemble :

```typ
#wikilink("Mon autre note")
```

Le texte entre les guillemets est le nom de fichier de la note cible (sans son extension).

#callout("tip")[ Vous pouvez aussi sélectionner du texte d'abord, puis taper `[[` pour envelopper votre sélection dans un lien. Le lien wiki complet ressemble à `[[nomdefichier]]` dans l'éditeur visuel ]

=== Lier vers une note qui n'existe pas encore

Vous n'avez pas besoin de créer une note avant de pouvoir la lier. Si le nom que vous tapez ne correspond à aucune note existante, le sélecteur affiche une rangée supplémentaire au bas :

- *Créer : {name}* insère le lien tout de suite ; la note elle-même est créée la première fois que vous cliquez pour l'atteindre.

Quand ce premier clic se produit, InkyCap crée la note avec la règle de création intégrée *Nouvelle note*, la même qui se trouve derrière le bouton *Nouvelle note* et *Ctrl+N*. Ainsi, une note née d'un lien commence avec le même contenu (titre, date, et ainsi de suite) et atterrit dans le même dossier que toute autre nouvelle note ; seul son nom de fichier provient du lien. Les règles de création sont décrites dans #wikilink("3 - Scaffolds, Templates et Packages").

#callout("note")[ Les noms de note sont uniques à l'échelle d'une boîte de notes, peu importe le dossier où la note se trouve. Cela veut dire que chaque lien doit se résoudre vers exactement une note. Si jamais vous tentez de créer une note dont le nom est déjà pris (avec le bouton *Nouvelle note*, par exemple), InkyCap s'arrête et vous demande ce que vous vouliez faire : *Ouvrir la note existante*, *Ajouter un ZID* (offert quand les identifiants Zettelkasten sont activés) ou *Utiliser un nom différent*. ]

C'est une façon naturelle d'écrire : #highlight(fill: rgb("#c8f0c8"))[notez un lien vers une idée que vous n'avez pas encore étoffée, continuez d'écrire et remplissez cette note plus tard]. Tant que la note n'existe pas, InkyCap marque le lien comme *non résolu*, de sorte que vous voyez d'un coup d'œil quels liens ont encore besoin d'une destination. Un lien non résolu reçoit un style distinct dans l'éditeur visuel (et une commande « créer » à icône pointillée dans le panneau Liens, décrite plus bas).

== Afficher un texte différent sur un lien

Parfois, le nom de fichier de la note n'est pas la formulation que vous voulez dans votre phrase. Vous pouvez donner à un lien son propre texte d'affichage. Dans le balisage sous-jacent, c'est l'option `display:` :

```typ
#wikilink("Théorie de l'esprit", display: "comment nous modélisons l'esprit des autres")
```

Le lien pointe toujours vers la même note, mais votre phrase se lit naturellement. Une autre technique consiste à utiliser la propriété `aliases` (voir plus bas).

== Alias : laisser une note répondre à plusieurs noms

Souvent, une note mérite plus d'un nom. Une note intitulée « Apprentissage automatique » pourrait aussi être appelée « AA ». Les alias permettent qu'une note soit trouvée et liée par n'importe lequel de ses noms de rechange.

Vous définissez les alias comme une propriété de note (vue dans #wikilink("6 - Propriétés des notes")). Dans la valeur de la propriété, listez les noms de rechange séparés par des virgules (par exemple `AA, Apprentissage automatique`). InkyCap découpe cela sur les virgules, de sorte que chacun devient son propre alias.

Une fois définis, les alias alimentent le sélecteur de liens wiki. Quand vous tapez un alias, le sélecteur montre la vraie note avec un indice atténué du genre *via l'alias « AA »*, et la choisir insère un lien qui *affiche* le texte de l'alias tout en pointant vers la bonne note :

```typ
#wikilink("Apprentissage automatique", display: "AA")
```

#callout("important")[ Les alias vous aident à *trouver et étiqueter* un lien dans le sélecteur, et ils définissent le texte affiché. Ils ne créent pas, à eux seuls, un rétrolien sous un nom inventé : les rétroliens sont résolus par le vrai nom de fichier de la note. Un lien s'enregistrera comme rétrolien tant qu'il pointe vers un vrai fichier de note. ]

== Lier vers un titre précis

Un lien peut sauter non seulement vers une note, mais vers une section particulière à l'intérieur de celle-ci. Utilisez le raccourci d'InkyCap en tapant un double deux-points après le nom de la note pour choisir un titre.

Après avoir choisi une note dans le sélecteur, vous avez deux façons d'entrer en *mode titre* :

- Tapez `::` après le nom de la note (par exemple `[[Ma note::`), ou
- Appuyez sur *Tab* sur une note surlignée dans la liste.

Le sélecteur affiche alors les titres de cette note, en retrait selon le niveau, suivis des étiquettes que son auteur a attachées à de la prose, des figures ou des équations (une rangée d'étiquette commence par les mots qu'elle marque, avec le nom de l'étiquette en dessous). Un pied de page vous rappelle : « Choisissez un titre ou une étiquette pour créer un lien vers cet endroit ». Si la note n'a ni l'un ni l'autre, le sélecteur affiche « Aucun titre ni étiquette dans cette note ». Choisissez-en un, et InkyCap insère un lien qui amène le lecteur à cet endroit exact et le fait défiler à l'écran. Le balisage sous-jacent utilise l'option `label:` :

```typ
#wikilink("Ma note", label: "la-section")
```

Les indications du pied de page dans le sélecteur vous guident à travers cela :

- « Saisissez :: après le nom d'une note pour créer un lien vers un titre »
- « …ou appuyez sur Tab sur une page ci-dessus pour choisir parmi ses titres »

#callout("tip", title: "Pour les utilisateurs de Typst")[ Un lien wiki est une fonction Typst : `#wikilink(name, display: none, label: none)`. Le `name` positionnel est le radical du fichier ; `display:` remplace le texte rendu ; `label:` ancre vers un titre. Chaque appel émet aussi des métadonnées `<inkycap-link>` interrogeables (`(target, from: "body")`) qui sont la source à partir de laquelle les rétroliens sont déterminés. Quand vous ciblez un titre, InkyCap réutilise l'étiquette existante du titre s'il en a une, sinon il transforme le texte du titre en radical (slug) et insère un `<label>` dans la note cible pour que l'ancre soit stable. C'est pourquoi, dans la forme à crochets de l'éditeur visuel, vous voyez le *slug* de l'étiquette (`Ma note::la-section`) plutôt que le texte humain du titre ; le slug est la source `label:` modifiable. ]

== Suivre les liens en lisant et en écrivant

Les liens wiki sont cliquables partout où ils apparaissent :

- *Cliquez* sur un lien pour ouvrir la note dans votre onglet courant. Si la note n'existe pas encore, le clic la crée.
- *Ctrl/Cmd+clic* ou *clic du milieu* pour l'ouvrir plutôt dans un nouvel onglet.
- *Clic droit* pour plus d'options : *Ouvrir dans un nouvel onglet*, *Ouvrir dans un onglet Rouleau de journal* et *Ouvrir dans un onglet Vue mycélienne*.

Ils se comportent de la même façon partout où un lien peut apparaître : dans le corps d'une note, à l'intérieur des callouts et des citations, dans l'éditeur de propriétés et dans le #wikilink("4 - Rouleau de journal").

Pour en savoir plus sur la façon dont l'éditeur rend les liens quand vous déplacez votre curseur, voir #wikilink("2 - Modifier des notes").

== Liens externes : le web, le courriel, les fichiers

Les liens peuvent pointer hors de votre boîte de notes. Vous pouvez lier vers des sites web, une adresse de courriel ou un fichier sur votre ordinateur.

La palette de commandes `/` propose deux insertions toutes prêtes :

- *Lien wiki* (sous « InkyCap ») insère un lien de note.
- *Lien* (sous « Insérer ») insère un lien externe avec son propre texte :

```typ
#link("https://inkycap.org")[texte convivial]
```

Dans l'éditeur source, une adresse web nue ou un `#link(...)` devient cliquable avec *Ctrl/Cmd+clic*. Maintenez la touche de modification et survolez : InkyCap affiche une infobulle « Ctrl/Cmd+Click to follow link » avec un curseur pointeur.

La destination d'un lien dépend de ce qu'il est :

- Les adresses avec un schéma (`https`, `http`, `mailto:`, `zotero://`, et autres) s'ouvrent dans le gestionnaire par défaut de votre système d'exploitation (votre navigateur, votre application de courriel ou votre gestionnaire de références).
- Un chemin qui commence par `/`, (ou, sous Windows, une lettre de lecteur comme `C:\`), est traité comme un fichier à l'intérieur de votre boîte de notes et ouvert avec son application par défaut.

=== Coller une adresse web

Vous pouvez aussi coller une adresse web directement depuis votre presse-papiers. Ce qui se passe dépend de l'endroit où se trouve votre curseur :

- Si vous avez d'abord *sélectionné du texte*, un petit menu surgissant *Coller comme* apparaît avec deux choix. *Lien* transforme votre sélection en texte du lien (`#link("https://…")[vos mots]`), et *Texte brut* remplace la sélection par l'adresse elle-même. Utilisez les touches fléchées et *Entrée*, ou cliquez, pour choisir ; *Échap* annule.
- Si rien n'est sélectionné, l'adresse est simplement insérée comme texte. Il n'y a pas de menu surgissant, parce que l'éditeur visuel affiche déjà une adresse web nue comme quelque chose sur quoi vous pouvez cliquer.
- Si votre curseur est déjà à l'intérieur de la partie adresse d'un appel `#link(...)`, l'adresse collée se place directement à cet endroit.


== Les rétroliens comptent : le modèle réciproque

Quand vous mentionnez (liez) une note à l'intérieur d'une autre, deux choses se produisent :

+ Cliquer sur le lien vous amène directement à l'autre note (et la crée pour vous si elle n'existe pas encore).
+ L'autre note gagne automatiquement un *rétrolien*, un enregistrement qui dit « cette note pointe vers moi ».

Ce modèle réciproque est ce qui permet à votre boîte de notes de devenir un réseau connecté plutôt qu'un tas de fichiers épars. Plus vous liez, plus vos notes gagnent de nouveaux contextes pour votre travail et votre réflexion. Avec le temps, vous pouvez bâtir des milliers de connexions, que la #wikilink("5 - Vue mycélienne") visualisera en concepts que vos notes elles-mêmes vous suggèrent d'explorer.

Vous lisez ces connexions dans l'onglet *Liens* du panneau de droite. Il comporte trois sections repliables, chacune avec un compteur et un état ouvert/fermé mémorisé :

+ *Liens entrants* : les notes qui pointent *vers* la note que vous regardez (ses _rétroliens_). Déployez une rangée pour prévisualiser la ligne où le lien apparaît, avec un contexte environnant optionnel ; double-cliquez sur une rangée pour basculer cet aperçu.
+ *Liens sortants* : les notes vers lesquelles votre note active pointe. Les liens vers des notes qui n'existent pas encore apparaissent comme *non résolus*, avec une icône de fichier en pointillé et un bouton *créer* ; cliquer sur la rangée ou le bouton crée la note manquante sur-le-champ.
+ *Liens wiki possibles* : les notes qui *mentionnent le nom de cette note en texte clair* mais ne l'ont pas encore vraiment liée.

Le panneau vous donne quelques façons de retrouver des notes dans une liste chargée :

- *Trier les liens* par nom, date de modification, date de création ou ZID (l'identifiant Zettelkasten, si vos notes en portent un), en ordre croissant ou décroissant. Les entrées non résolues se trient toujours au bas.
- *Développer les aperçus / Réduire les aperçus* affiche ou masque les lignes de contexte de chaque rangée d'un coup.
- *Filtrer les liens par nom* avec une boîte de recherche (« Rechercher dans les liens... ») qui restreint les listes. Elle prend en charge toute la syntaxe de recherche (phrases entre guillemets, `AND`/`OR`/`NOT` et filtres comme `tag:`, `file:`, `path:` et `property:`) limitée aux seuls liens de cette note. (Pour en savoir plus sur les étiquettes, voir #wikilink("5 - Étiquettes").)

#callout("note")[ Quand vous ouvrez une grande boîte de notes pour la première fois, InkyCap construit son index de liens en arrière-plan. Le panneau Liens peut paraître vide un instant et se remplira automatiquement une fois cela terminé. ]

=== Les liens survivent au renommage et au déplacement

Vous pouvez renommer ou réorganiser librement sans briser les connexions de vos liens. Le réglage *Mettre à jour les liens automatiquement au renommage* (« Lorsqu'un fichier est renommé, mettre à jour automatiquement les références qui le visent ») est activé par défaut. Quand vous renommez une note, InkyCap réécrit chaque lien qui pointait vers l'ancien nom (sous la forme à crochets comme sous la forme complète) pour qu'ils suivent tous la note vers son nouveau nom.

=== Pour les utilisateurs de Typst

#callout("tip", title: "Utilisateurs Typst avancés")[ Les liens et rétroliens passent par des métadonnées natives de Typst. Les liens wiki de corps et les valeurs `link-ref` de métadonnées émettent tous deux l'étiquette `<inkycap-link>` (`from: "body"` contre `from: "metadata"`), et les rétroliens sont l'inverse de ces arêtes. La résolution associe une cible à un fichier par *radical insensible à la casse* ; quand plusieurs fichiers correspondent, le chemin le plus court l'emporte, et les suffixes de titre (`Note::titre`) sont d'abord retirés. Une valeur `link-ref(name)` permet à une propriété typée dans `#note(...)` de pointer vers une autre note tout en produisant un vrai rétrolien. Le fait que les liens wiki se rendent en mode lecture et à l'exportation est régi par le réglage *Afficher les liens wiki en ligne* (activé par défaut), qui correspond à un état `#set-notebox(show-inline-wikilinks: …)` que vous pouvez aussi remplacer par document. Quand vous exportez une collection sous forme de livre, une option *Liens wiki* distincte vous permet de résoudre les liens vers les chapitres du livre, de les garder pointés vers les fichiers source, ou de les réduire en texte clair. ]
\

== Pages connexes

- #wikilink("6 - Propriétés des notes"). Là où vous définissez les alias d'une note.
- #wikilink("2 - Modifier des notes"). Comment les liens se rendent à mesure que vous écrivez.
- #wikilink("5 - Vue mycélienne"). Voir vos liens comme une carte visuelle des connexions.
- #wikilink("5 - Étiquettes"). Une autre façon de regrouper et retrouver des notes apparentées.
- #wikilink("4 - Rouleau de journal"). Une surface de lecture continue où les liens restent vivants.
