#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "L'interface InkyCap",
  description: "Une visite guidée de la fenêtre d'InkyCap : barre d'outils, barres latérales gauche et droite, onglets et panneaux divisés, barre d'état, Palette de commandes, Ouverture rapide et modes de concentration.",
  tags: ("documentation",),
  aliases: ("Interface InkyCap",),
)

= L'interface InkyCap

La fenêtre d'InkyCap est disposée en bandes verticales, de gauche à droite :

+ Une étroite *barre d'outils verticale* d'icônes tout à gauche, toujours visible.
+ La *barre latérale gauche*, qui contient les outils de l'application (vos fichiers, collections, propriétés, agenda, et ainsi de suite).
+ La *zone d'édition* au centre, où vos notes s'ouvrent sous forme d'onglets que vous pouvez diviser en panneaux supplémentaires.
+ Le *panneau de droite*, qui affiche de l'information sur ce sur quoi vous travaillez en ce moment.

Tout au bas se trouve la *barre d'état*, avec le nom de votre boîte de notes, le nombre de mots et d'autres détails en un coup d'œil.

Vous pouvez masquer l'une ou l'autre des barres latérales pour gagner de la place. Appuyez sur `Ctrl+/` pour afficher ou masquer la barre latérale gauche et `Ctrl+\\` pour le panneau de droite.

== La barre d'outils verticale

Il s'agit de la mince bande d'icônes tout à gauche. Elle reste visible même quand vous repliez la barre latérale gauche. De haut en bas, vous y trouverez :

- Un *bouton d'affichage/masquage de la barre latérale* (l'icône de panneau tout en haut). Quand la barre latérale gauche est repliée, c'est ainsi que vous la ramenez.
- *Recherche* ouvre une recherche dans toute la boîte de notes dans la barre latérale. Vous pouvez aussi appuyer sur *Ctrl+Shift+F*.
- *Boutons de règle de création*. Si vous avez configuré des raccourcis de création de notes qui s'ajoutent à la barre d'outils, chacun apparaît ici avec sa propre icône, prêt à créer une nouvelle note en un clic. Voyez #wikilink("3 - Scaffolds, Templates et Packages") pour savoir comment les configurer.
- Un *bouton de thème* (un soleil ou une lune) pour basculer entre le mode clair et le mode foncé. Raccourci : *Ctrl+Shift+L*.
- *Templates* ouvre le panneau Scaffolds, Templates et Packages.
- *Aide* ouvre le panneau d'aide intégré à l'application. Vous pouvez aussi appuyer sur *F1*.
- *Paramètres* ouvre la fenêtre des Paramètres. Raccourci : *Ctrl+,*. Voyez #wikilink("2 - Paramètres").
\

== La barre latérale gauche : vos outils

En haut de la barre latérale gauche se trouve une rangée de boutons-icônes, la *barre de modes*. Chacun fait passer le panneau du dessous à un outil différent. Il y a six modes intégrés :

+ L'*arborescence de fichiers* présente chaque fichier de votre boîte de notes, affiché sous forme d'arbre de dossiers.
+ Les *Collections* sont vos groupes de notes rassemblées pour la publication. Voyez #wikilink("2 - Collections").
+ L'*Agenda* rassemble les tâches et les éléments datés tirés de partout dans votre boîte de notes. Voyez #wikilink("3 - Agenda, tâches et dates").
+ Les *Propriétés* sont les champs typés que vous avez utilisés dans vos notes, comme les _étiquettes_ ou les _dates d'échéance_. Voyez #wikilink("6 - Propriétés des notes").
+ Les *Étiquettes* forment une liste plate de chaque étiquette, avec la fréquence d'utilisation de chacune. Voyez #wikilink("5 - Étiquettes").
+ Les *Signets* sont les notes que vous avez marquées pour les retrouver rapidement.

Quelques autres panneaux (Recherche, Templates, Aide et Collaboration) se trouvent ici aussi, mais s'ouvrent depuis la barre d'outils ou un raccourci plutôt que depuis la barre de modes.

=== L'arborescence de fichiers

Utilisez l'arborescence de fichiers pour parcourir vos dossiers et ouvrir des notes. Elle affichera les dossiers et les fichiers dans l'ordre que vous avez choisi dans les paramètres.

- Les notes (fichiers `.typ`) et les fichiers de collection s'ouvrent directement dans InkyCap. Les autres fichiers (images, PDF, fichiers de bibliographie, données) sont affichés mais atténués, et s'ouvrent dans l'application par défaut de votre ordinateur quand vous cliquez dessus.
- L'en-tête comporte un *menu de tri* (Nom A→Z ou Z→A, Modifié ou Créé), un bouton *tout déplier / tout replier* et un bouton *« Nouveau »* pour créer une nouvelle note, un nouveau dossier ou téléverser un fichier dans votre boîte de notes.
- Un clic droit sur un fichier ou un dossier vous donne Nouveau fichier, Nouveau dossier, Signet (sur les notes), Renommer, Déplacer et Supprimer.
- Pour ouvrir une note dans un *nouvel onglet* plutôt que dans l'onglet courant, maintenez *Ctrl* (ou *Cmd*) enfoncé pendant que vous cliquez dessus.

Vous pouvez aussi *glisser un fichier sur un dossier* pour le déplacer. La destination se met en surbrillance, le fichier que vous glissez s'atténue, et une petite pastille suit votre curseur pour que vous voyiez exactement où il atterrira.

#callout("important")[ Si votre onglet actif est un #wikilink("4 - Rouleau de journal"), cliquer sur une note dans l'arborescence _réancre_ le rouleau sur cette note plutôt que de l'ouvrir dans un nouvel onglet. Maintenez *Ctrl* (ou *Cmd*) et cliquez si vous voulez plutôt un onglet normal. ]

=== Agenda
Le panneau Agenda vous permet de filtrer par état de tâche et par étiquettes, et de trier par date d'échéance, par création ou par nom.


=== Panneaux Propriétés et Étiquettes
Les panneaux Propriétés et Étiquettes affichent chacun une liste de tous les noms de propriété ou de toutes les étiquettes utilisés dans la boîte de notes, avec un décompte. Cliquer sur l'un d'eux lance une recherche des fichiers qui les contiennent.

=== Signets

Les signets sont des notes, des collections et des recherches enregistrées que vous avez marquées pour les atteindre d'un seul clic. Ils vivent dans le panneau *Signets* et persistent entre les sessions. Il y a plusieurs façons d'en ajouter un :

- *Une note depuis l'arborescence des fichiers.* Cliquez avec le bouton droit sur une note dans l'arborescence et choisissez *Signet*.
- *Une note depuis le menu Actions sur le fichier.* Dans le menu *Actions sur le fichier* du panneau de droite (décrit ci-dessous), choisissez *Ajouter un signet…*.
- *Une collection.* Cliquez avec le bouton droit sur une collection dans la liste des Collections et choisissez *Signet*.
- *Une recherche.* Dans le #wikilink("2 - Recherche et récupération", display: "panneau Recherche"), ouvrez le menu *Plus d'actions* et choisissez *Mettre l'expression de recherche en signet…*.

Dans le panneau Signets, cliquez sur n'importe quel signet pour l'ouvrir : une note s'ouvre dans un onglet, une collection dans sa vue de collection, et une recherche enregistrée rouvre le panneau Recherche et s'exécute. Glissez la poignée pour les réorganiser, et utilisez le bouton `×` pour en retirer un. Quand vous n'en avez aucun, le panneau vous le rappelle : « Aucun signet pour l'instant. Cliquez avec le bouton droit sur un fichier ou une collection pour l'ajouter aux signets. »


== Le panneau de droite : le contexte qui vous suit

Les onglets du panneau de droite changent selon ce que vous avez ouvert. Il affiche ce qui est pertinent dans l'éditeur.

Quand une *note* est active, le panneau de droite vous offre :

- *Actions sur le fichier* est un menu avec Renommer, Déplacer, Ajouter un signet, Exporter, Rechercher, Remplacer, Afficher dans l'explorateur, Afficher dans l'arborescence (met le fichier en surbrillance) et Supprimer.
- *Plan* est l'arbre des titres de votre document. C'est comme une table des matières sur laquelle vous pouvez cliquer pour sauter à des sections dans les notes longues.
- *Propriétés* est un éditeur des métadonnées propres à la note, comme le titre, les étiquettes, la date et l'échéance. Voyez #wikilink("6 - Propriétés des notes").
- *Liens* affiche les connexions de votre note, regroupées en Entrants (rétroliens), Sortants et Liens potentiels. Voyez #wikilink("4 - Liens et rétroliens").
- *Références* est le panneau de bibliographie. Voyez #wikilink("7 - Citations et bibliographie").
- *Modifications et historique* vous permet de réviser les suggestions, les modifications suivies et les annotations. Un petit point apparaît sur cet onglet quand des modifications suggérées attendent que vous les acceptiez ou les refusiez.

Quand vous ouvrez une *collection*, le panneau de droite passe à Caractéristiques, Remplacements de style et Métadonnées et structure du livre. Quand vous ouvrez une #wikilink("5 - Vue mycélienne"), il affiche plutôt Contexte lié et Filtrage de concepts.

== Onglets et panneaux divisés

Les notes s'ouvrent sous forme d'*onglets* en haut de la zone d'édition. Un onglet affiche une icône de type pour les vues spéciales (un rouleau pour un #wikilink("4 - Rouleau de journal"), un cerveau pour une #wikilink("5 - Vue mycélienne"), et ainsi de suite), et un *point* (●) quand il a des modifications non enregistrées.

- *Réorganisez* les onglets en les glissant à l'intérieur d'un panneau.
- *Déplacez* un onglet vers un autre panneau en le glissant d'un côté à l'autre.
- Raccourcis d'onglets courants : nouvel onglet vide *Ctrl+T*, fermer l'onglet *Ctrl+W*, rouvrir le dernier onglet fermé *Ctrl+Shift+T*, et onglet suivant / précédent avec *Ctrl+Tab* / *Ctrl+Shift+Tab*.

Pour travailler sur deux choses à la fois, *divisez l'éditeur*. Au bord droit de la barre d'onglets se trouve un menu *Options d'onglets* avec « Diviser à droite », « Diviser vers le bas » et « Fermer ce panneau », en plus d'une liste rapide des onglets de ce panneau.

- Diviser à droite : `Ctrl+Shift+]`
- Diviser vers le bas : `Ctrl+Shift+[`
- Fermer le panneau : *Ctrl+Shift+W*

Chaque panneau conserve son propre format de lecture et son propre contexte de panneau de droite, de sorte que vous pouvez, par exemple, rédiger dans un panneau pendant que vous lisez une référence dans un autre.

#callout("tip")[ Chaque note peut être affichée selon trois modes : *Mode source*, *Édition visuelle* et *Mode lecture*. Basculez entre le mode source et le mode visuel avec *Ctrl+Shift+M*, et activez ou désactivez le mode lecture avec *Ctrl+Shift+R*. Voyez #wikilink("2 - Modifier des notes") pour savoir à quoi chaque mode convient le mieux. ]

== La barre d'état

La barre tout au bas vous donne un état rapide et des actions rapides. De gauche à droite :

- *Nom de la boîte de notes*. Cliquez dessus pour changer de boîte de notes, en ouvrir une dans une nouvelle fenêtre, démarrer une nouvelle fenêtre ou gérer vos boîtes de notes.
- *Nombre de fichiers* indique combien de fichiers se trouvent dans la boîte de notes.
- La *pastille de collaboration* n'apparaît que dans une boîte de notes partagée, affichant l'état de synchronisation en un coup d'œil. Voyez #wikilink("1 - Collaboration").
- *Chemin du fichier* est l'emplacement de la note active, avec un bouton *renommer* en ligne (vous pouvez aussi renommer avec *F2*).
- *Position du curseur* (ligne et colonne) ne s'affiche qu'en Mode source, où les positions concordent.
- La *pastille de correction orthographique* indique le dictionnaire courant et vous permet de le changer.
- *Nombre de mots / de caractères* affiche votre nombre de mots ; *cliquez dessus* pour passer à un nombre de caractères, et cliquez de nouveau pour revenir.
- Le *bouton sans distraction* se trouve tout à droite, toujours disponible.

== Palette de commandes et Ouverture rapide

Deux superpositions vous permettent de faire presque tout sans fouiller dans les menus.

La *Palette de commandes* (*Ctrl+P*) énumère chaque commande d'InkyCap. Commencez à taper pour faire une recherche approximative ; les lettres correspondantes sont mises en surbrillance, et chaque résultat affiche son raccourci clavier. Quand le champ est vide, les commandes sont regroupées en catégories repliables (Fichier, Édition, Affichage, Naviguer, et plus) que vous pouvez parcourir avec les touches fléchées.

L'*Ouverture rapide* (*Ctrl+O*) sert à sauter à une note par son nom. Quand le champ est vide, elle _énumère vos notes, les plus récemment modifiées en premier_ ; commencez à taper pour faire une correspondance approximative sur le nom du fichier. Appuyez sur Entrée pour ouvrir la note mise en surbrillance. Elle reste rapide même dans une boîte de notes de milliers de notes.

#callout("tip", title: "Astuces de la palette de commandes")[ Les rangées de la Palette de commandes affichent aussi un indice de balisage à côté des commandes de mise en forme (par exemple `*…*` pour le gras), pour que vous appreniez la syntaxe Typst sous-jacente au fil de l'eau. La palette est le seul endroit pour lancer une recherche-remplacement dans toute la boîte de notes ; elle n'a pas de touche dédiée, et c'est voulu. ]

== Modes sans distraction, concentration et machine à écrire

Ce sont trois façons distinctes de calmer l'écran, et vous pouvez les combiner :

- Le *mode sans distraction* masque les barres latérales et l'interface et réduit la barre d'état dans le coin. Activez-le avec le bouton de la barre d'état ou *Ctrl+Shift+1*, et quittez-le avec *Esc*.
- Le *mode concentration* met doucement en surbrillance seulement la ligne ou le paragraphe sur lequel vous travaillez (et peut atténuer le reste). Vous l'activez dans les #wikilink("2 - Paramètres").
- Le *mode machine à écrire* garde la ligne que vous tapez épinglée au centre vertical de l'écran, pour que vos yeux restent au même endroit. C'est aussi un paramètre, et il est actif en mode Édition visuelle.

== Se déplacer au clavier

InkyCap divise la fenêtre en *régions* (la barre latérale, chaque panneau d'éditeur, le panneau de droite et la barre d'état) entre lesquelles vous pouvez vous déplacer sans la souris :

- *F6* / *Shift+F6* font défiler les régions visibles vers l'avant et vers l'arrière.
- *Ctrl+Shift+0* saute directement à l'éditeur.
- *Esc* depuis n'importe quelle région autre que l'éditeur vous y ramène.
- *Ctrl+PageDown* / *Ctrl+PageUp* font défiler les onglets propres au panneau ciblé.

Pour la liste complète des raccourcis, voyez #wikilink("3 - Raccourcis clavier").

== Glisser-déposer depuis l'extérieur d'InkyCap

Vous pouvez glisser des fichiers directement de votre bureau dans l'éditeur. InkyCap les copie dans votre dossier de pièces jointes et insère le bon type de référence au point de dépôt. Une image devient une image en ligne, un fichier vidéo ou audio devient un lecteur, une autre note devient un lien vers cette note, et tout le reste devient un lien de fichier cliquable. Les adresses web collées sont automatiquement transformées en liens.

== Pages connexes

- #wikilink("1 - Prise en main")
- #wikilink("2 - Modifier des notes")
- #wikilink("2 - Paramètres")
- #wikilink("3 - Raccourcis clavier")
- #wikilink("4 - Rouleau de journal")
- #wikilink("5 - Vue mycélienne")
- #wikilink("3 - Agenda, tâches et dates")
- #wikilink("2 - Collections")
