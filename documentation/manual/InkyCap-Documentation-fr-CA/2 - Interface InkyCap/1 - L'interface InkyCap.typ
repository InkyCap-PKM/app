#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "L'interface InkyCap",
  description: "Une visite guidée de la fenêtre d'InkyCap : barre d'outils, barres latérales gauche et droite, onglets et panneaux divisés, barre d'état, Palette de commandes, Ouverture rapide, panneau d'Aide et modes de concentration.",
  tags: ("documentation",),
  aliases: ("Interface InkyCap",),
)

= L'interface InkyCap

La fenêtre d'InkyCap est disposée en bandes verticales, de gauche à droite :

+ Une étroite *barre d'outils verticale* d'icônes tout à gauche, toujours visible.
+ La *barre latérale gauche*, qui contient les outils de l'application (vos fichiers, collections, propriétés, agenda, recherche, et ainsi de suite).
+ La *zone d'édition* au centre, où vos notes s'ouvrent sous forme d'onglets que vous pouvez diviser en panneaux supplémentaires.
+ Le *panneau de droite*, qui affiche de l'information sur ce sur quoi vous travaillez en ce moment.

Tout au bas se trouve la *barre d'état*, avec le nom de votre boîte de notes, le nombre de mots et d'autres détails en un coup d'œil.

Vous pouvez masquer l'une ou l'autre des barres latérales pour gagner de la place. Appuyez sur `Ctrl+/` pour afficher ou masquer la barre latérale gauche et `Ctrl+\` pour le panneau de droite.

== La barre d'outils verticale

Il s'agit de la mince bande d'icônes tout à gauche. Elle reste visible même quand vous repliez la barre latérale gauche. De haut en bas, vous y trouverez :

- Un *bouton d'affichage/masquage de la barre latérale* (l'icône de panneau tout en haut). Quand la barre latérale gauche est repliée, c'est ainsi que vous la ramenez.
- *Recherche* ouvre une recherche dans toute la boîte de notes dans la barre latérale. Vous pouvez aussi appuyer sur *Ctrl+Shift+F*.
- *Boutons de règle de création*. Si vous avez configuré des raccourcis de création de notes qui s'ajoutent à la barre d'outils, chacun apparaît ici avec sa propre icône, prêt à créer une nouvelle note en un clic. Voyez #wikilink("3 - Scaffolds, Templates et Packages") pour savoir comment les configurer.
- Un *bouton de thème* (un soleil ou une lune) pour basculer entre le mode clair et le mode sombre. Raccourci : *Ctrl+Shift+L*.
- *Templates* ouvre le panneau Scaffolds, Templates et Packages.
- *Aide* ouvre le panneau d'Aide intégré à l'application (décrit dans sa propre section ci-dessous). Vous pouvez aussi appuyer sur *F1*.
- *Paramètres* ouvre la fenêtre des Paramètres. Raccourci : *Ctrl+,*. Voyez #wikilink("2 - Paramètres").
\

== La barre latérale gauche : vos outils

En haut de la barre latérale gauche se trouve une rangée de boutons-icônes, la *barre de modes*. Chacun fait passer le panneau du dessous à un outil différent. Les modes intégrés comprennent :

+ L'*Arborescence des fichiers* présente chaque fichier de votre boîte de notes, affiché sous forme d'arbre de dossiers.
+ Les *Collections* sont vos groupes de notes rassemblées pour des projets, pour la publication d'un article ou d'un livre, ou pour interroger de l'information comme dans une base de données à l'intérieur d'InkyCap. Voyez #wikilink("2 - Collections").
+ L'*Agenda* rassemble les tâches et les éléments datés tirés de partout dans votre boîte de notes. Voyez #wikilink("3 - Agenda, tâches et dates").
+ Les *Propriétés* sont les champs typés que vous avez utilisés dans vos notes, comme les _étiquettes_ ou les _dates d'échéance_. Voyez #wikilink("6 - Propriétés des notes").
+ Les *Étiquettes* forment une liste plate de chaque étiquette, avec la fréquence d'utilisation de chacune. Voyez #wikilink("5 - Étiquettes").
+ Les *Signets* sont les notes ou les expressions de recherche que vous avez marquées pour les retrouver rapidement.

Quelques autres panneaux (Recherche, Templates, Aide et Collaboration) se trouvent ici aussi, mais s'ouvrent depuis la barre d'outils ou un raccourci plutôt que depuis la barre de modes.

=== L'arborescence des fichiers

Utilisez l'arborescence des fichiers pour parcourir vos dossiers et ouvrir des notes. Elle affichera les dossiers et les fichiers dans l'ordre que vous avez choisi dans les paramètres.

- Les notes (fichiers `.typ`) et les fichiers de collection s'ouvrent directement dans InkyCap. Les autres fichiers (images, PDF, fichiers de bibliographie, données) sont affichés mais atténués, et s'ouvrent dans l'application par défaut de votre ordinateur quand vous cliquez dessus.
- L'en-tête comporte un *menu de tri* (Nom A→Z ou Z→A, Modifié, Créé, ou ZID croissant ou décroissant), un bouton *tout développer / tout réduire* et un bouton *« Nouveau »* pour créer une nouvelle note, un nouveau dossier ou téléverser un fichier dans votre boîte de notes. Les noms sont triés comme une personne le ferait, de sorte que « Chapitre 2 » vient avant « Chapitre 10 ».
- Un clic droit sur un fichier ou un dossier vous donne *Ouvrir dans un nouvel onglet*, *Nouvelle note*, *Nouveau dossier*, *Signet* (sur les notes), *Renommer*, *Déplacer le fichier vers...* (ou *Déplacer le dossier vers...*) et *Supprimer*. Un clic droit sur un dossier offre aussi *Rechercher dans le dossier*, qui ouvre le panneau Recherche limité à ce dossier.
- Pour ouvrir une note dans un *nouvel onglet* plutôt que dans l'onglet courant, maintenez *Ctrl* (ou *Cmd*) enfoncé pendant que vous cliquez dessus, ou cliquez dessus avec le bouton du milieu de la souris. Que ce nouvel onglet passe au premier plan ou reste en arrière-plan dépend du paramètre *Passer immédiatement aux nouveaux onglets* sous *Comportement* dans #wikilink("2 - Paramètres").

Vous pouvez aussi *glisser un fichier sur un dossier* pour le déplacer.

#callout("important")[ Si votre onglet actif est un #wikilink("4 - Rouleau de journal"), cliquer sur une note dans l'arborescence _réancre_ le rouleau sur cette note plutôt que de l'ouvrir dans un nouvel onglet. Maintenez *Ctrl* (ou *Cmd*) et cliquez si vous voulez plutôt un onglet normal. ]

=== Agenda
Le panneau Agenda vous permet de filtrer par état de tâche et par étiquettes, et de trier par date d'échéance, par création ou par nom.


=== Panneaux Propriétés et Étiquettes
Les panneaux Propriétés et Étiquettes affichent chacun une liste de tous les noms de propriété ou de toutes les étiquettes utilisés dans la boîte de notes, avec un décompte. Cliquer sur l'un d'eux lance une recherche des fichiers qui les contiennent.

=== Signets

Les signets sont de quatre sortes : des notes, des collections, des recherches enregistrées et des vues d'Agenda enregistrées. Ce sont des éléments que vous avez marqués pour les atteindre d'un seul clic. Ils vivent dans le panneau *Signets* et persistent entre les sessions. Il y a plusieurs façons d'en ajouter un :

- *Une note depuis l'arborescence des fichiers.* Cliquez avec le bouton droit sur une note dans l'arborescence et choisissez *Signet*.
- *Une note depuis le menu Actions sur le fichier.* Dans le menu *Actions sur le fichier* du panneau de droite (décrit ci-dessous), choisissez *Ajouter un signet...*.
- *Une collection.* Cliquez avec le bouton droit sur une collection dans la liste des Collections et choisissez *Signet*.
- *Une recherche.* Dans le #wikilink("2 - Recherche et récupération", display: "panneau Recherche"), ouvrez le menu *Plus d'actions* et choisissez *Mettre l'expression de recherche en signet…*.
- *Une vue d'Agenda.* Dans le #wikilink("3 - Agenda, tâches et dates", display: "panneau Agenda"), réglez les filtres que vous voulez, puis choisissez *Ajouter la vue actuelle aux signets* et donnez-lui un nom.

Dans le panneau Signets, cliquez sur n'importe quel signet pour l'ouvrir : une note s'ouvre dans un onglet, une collection dans sa vue de collection, une recherche enregistrée rouvre le panneau Recherche et s'exécute, et une vue d'Agenda enregistrée rouvre l'Agenda avec ces filtres appliqués. Glissez la poignée pour les réorganiser, et utilisez le bouton `×` pour en retirer un.


== Le panneau de droite : le contexte

Les onglets du panneau de droite changent selon ce que vous avez ouvert. Il affiche ce qui est pertinent dans l'éditeur.

Quand une *note* est active, le panneau de droite vous offre :

- *Actions sur le fichier* est un menu avec *Renommer...*, *Déplacer le fichier vers...*, *Ajouter un signet...*, *Exporter...*, *Rechercher...*, *Remplacer...*, *Afficher dans l'arborescence des fichiers* (met le fichier en surbrillance), *Afficher dans le gestionnaire de fichiers du système* et *Supprimer le fichier*.
- *Plan* est l'arbre des titres de votre document. C'est comme une table des matières sur laquelle vous pouvez cliquer pour sauter à des sections dans les notes longues.
- *Propriétés* est un éditeur des métadonnées propres à la note, comme le titre, les étiquettes, la date et l'échéance. Voyez #wikilink("6 - Propriétés des notes").
- *Liens* affiche les connexions de votre note, regroupées en Liens entrants (rétroliens), Liens sortants et Liens wiki possibles. Voyez #wikilink("4 - Liens et rétroliens").
- *Références* est le panneau de bibliographie. Voyez #wikilink("7 - Citations et bibliographie").
- *Modifications et historique* vous permet de réviser les suggestions, les modifications suivies et les annotations. Un petit point apparaît sur cet onglet quand des modifications suggérées attendent que vous les acceptiez ou les refusiez.

Quand vous ouvrez une *collection*, le panneau de droite passe à Caractéristiques, Substitutions de style et Métadonnées et structure du livre. Quand vous ouvrez une #wikilink("5 - Vue mycélienne"), il affiche plutôt trois onglets : *Contexte lié*, *Croissance* et *Filtrage*.

== Onglets et panneaux divisés

Les notes s'ouvrent sous forme d'*onglets* en haut de la zone d'édition. Un onglet affiche une icône de type pour les vues spéciales (un rouleau pour un #wikilink("4 - Rouleau de journal"), un cerveau pour une #wikilink("5 - Vue mycélienne"), et ainsi de suite), et un *point* (●) quand il a des modifications non enregistrées.

- *Réorganisez* les onglets en les glissant à l'intérieur d'un panneau.
- *Déplacez* un onglet vers un autre panneau en le glissant d'un côté à l'autre.
- Ouvrez un nouvel onglet vide avec le bouton *+* à la fin de la barre d'onglets. Quand il y a plus d'onglets que d'espace, de petites flèches apparaissent à chaque extrémité pour les faire défiler.
- Raccourcis d'onglets courants : nouvel onglet vide *Ctrl+T*, fermer l'onglet *Ctrl+W*, rouvrir le dernier onglet fermé *Ctrl+Shift+T*, et onglet suivant / précédent avec *Ctrl+Tab* / *Ctrl+Shift+Tab*.

Chaque panneau, qu'il affiche une note ou une collection, comporte une petite *barre de navigation* en haut avec des flèches *Reculer* et *Avancer*. Elles parcourent l'historique de ce que cet onglet a affiché, de sorte qu'après avoir suivi quelques liens wiki, vous pouvez revenir sur vos pas.

Si vous aimeriez qu'InkyCap ramène vos onglets la prochaine fois que vous ouvrez une boîte de notes, choisissez *Onglets précédemment ouverts* sous *Comportement au démarrage* dans #wikilink("2 - Paramètres").

Pour travailler sur deux choses à la fois, *divisez l'éditeur*. Au bord droit de la barre d'onglets se trouve un menu *Options de l'onglet* avec *Diviser à droite*, *Diviser vers le bas*, *Diviser avec aperçu* et *Fermer ce volet*, en plus d'une liste rapide des onglets de ce panneau.

- Diviser à droite : `Ctrl+Shift+]`
- Diviser vers le bas : `Ctrl+Shift+[`
- Fermer le panneau : *Ctrl+Shift+W*

Chaque panneau conserve son propre format de lecture et son propre contexte de panneau de droite, de sorte que vous pouvez, par exemple, rédiger dans un panneau pendant que vous lisez une référence dans un autre.

*Diviser avec aperçu* ouvre un mode lecture en direct de la _même_ note à côté de l'éditeur, et cet aperçu se met à jour à mesure que vous tapez. L'onglet d'édition est marqué comme *Aperçu synchronisé* pour que vous puissiez distinguer la paire, et chaque note ne peut avoir qu'une seule paire de ce genre à la fois. L'aperçu utilise votre *Préférence de format du mode lecture* des #wikilink("2 - Paramètres"). Vous pouvez aussi en lancer un depuis la palette de commandes avec *Diviser avec un aperçu synchronisé* ; il n'a pas de raccourci clavier propre.

#callout("tip")[ Chaque note peut être affichée selon trois modes : *Édition source*, *Édition visuelle* et *Mode lecture*. Basculez entre le mode source et le mode visuel avec *Ctrl+Shift+M*, et activez ou désactivez le mode lecture avec *Ctrl+Shift+R*. Voyez #wikilink("2 - Modifier des notes") pour savoir à quoi chaque mode convient le mieux. ]

En mode lecture, le zoom fonctionne dans les formats SVG et HTML, et les liens wiki se comportent comme dans l'éditeur : cliquez sur l'un d'eux pour le suivre dans le même onglet, maintenez *Ctrl* (ou utilisez le bouton du milieu de la souris) pour l'ouvrir dans un nouvel onglet, ou cliquez dessus avec le bouton droit pour un menu. Les liens vers des pages web s'ouvrent dans votre navigateur habituel ou dans l'application système appropriée.

== La barre d'état

La barre tout au bas vous donne un état rapide et des actions rapides. De gauche à droite :

- *Nom de la boîte de notes*. Cliquez dessus pour changer de boîte de notes, en ouvrir une dans une nouvelle fenêtre, démarrer une nouvelle fenêtre ou gérer vos boîtes de notes.
- *Nombre de fichiers* indique combien de fichiers se trouvent dans la boîte de notes.
- La *pastille de collaboration* n'apparaît que dans une boîte de notes partagée, affichant l'état de synchronisation en un coup d'œil. Voyez #wikilink("1 - Collaboration").
- *Chemin du fichier* est l'emplacement de la note active, avec un bouton *renommer* en ligne (vous pouvez aussi renommer avec *F2*).
- *Position du curseur* (ligne et colonne) ne s'affiche qu'en mode Édition source, où les positions concordent.
- La *pastille de correction orthographique* indique le dictionnaire courant et vous permet de le changer.
- *Nombre de mots / de caractères* affiche votre nombre de mots ; *cliquez dessus* pour passer à un nombre de caractères, et cliquez de nouveau pour revenir.
- Le *bouton sans distraction* se trouve tout à droite, toujours disponible.

== Palette de commandes et Ouverture rapide

La *Palette de commandes* (*Ctrl+P*) énumère chaque commande d'InkyCap. Commencez à taper pour faire une recherche approximative ; les lettres correspondantes sont mises en surbrillance, et chaque résultat affiche son raccourci clavier. Quand le champ est vide, les commandes sont regroupées en catégories repliables (Fichier, Édition, Affichage, Naviguer, et plus) que vous pouvez parcourir avec les touches fléchées.

L'*Ouverture rapide* (*Ctrl+O*) sert à sauter à une note par son nom. Quand le champ est vide, elle _énumère vos notes, les plus récemment modifiées en premier_ ; commencez à taper pour faire une correspondance approximative sur le nom du fichier. Appuyez sur Entrée pour ouvrir la note mise en surbrillance.

#callout("tip", title: "Astuces de la palette de commandes")[ Les rangées de la Palette de commandes affichent aussi un indice de balisage à côté des commandes de mise en forme (par exemple `*…*` pour le gras), pour que vous appreniez la syntaxe Typst sous-jacente au fil de l'eau. La palette est le seul endroit pour lancer une recherche-remplacement dans toute la boîte de notes. ]

== Le panneau d'Aide

Appuyez sur *F1*, ou cliquez sur le bouton *Aide* de la barre d'outils verticale, pour ouvrir le panneau d'Aide dans la barre latérale gauche. Il comporte un champ de filtre en haut (tapez un mot pour restreindre chaque liste en dessous) et deux boutons qui ouvrent les manuels complets : *Documentation InkyCap*, qui ouvre ce manuel dans sa propre fenêtre, et *Documentation Typst*, qui ouvre la référence officielle de Typst dans votre navigateur. En dessous, un sélecteur bascule entre trois vues :

- *Raccourcis d'interface* énumère chaque raccourci clavier de l'application, regroupé par catégorie.
- *Éditeur visuel* énumère les touches de mise en forme et les raccourcis de saisie qui fonctionnent pendant que vous écrivez.
- *Balisage Typst* est un aide-mémoire du balisage Typst standard, avec quelques simplifications supplémentaires propres à InkyCap.

=== Définir des raccourcis personnalisés (touches de raccourci)

La vue *Raccourcis d'interface* est l'endroit où vous changez les raccourcis. Cliquez sur la combinaison de touches affichée à côté d'une commande, puis appuyez sur les nouvelles touches que vous voulez. Appuyez plutôt sur *Retour arrière* pour retirer le raccourci (il affiche alors *Non assigné*), ou sur *Esc* pour le laisser tel qu'il était. Si la combinaison sur laquelle vous appuyez appartient déjà à une autre commande, ou est réservée par l'éditeur (comme *Ctrl+B* pour le gras) ou par le système, InkyCap la refuse et vous indique à quoi elle sert. Un raccourci modifié affiche une petite flèche de réinitialisation à côté de lui qui rétablit la valeur par défaut, et un bouton *Réinitialiser tous les raccourcis* apparaît en haut de la vue dès que quelque chose a été personnalisé. Les raccourcis des règles de création de notes (comme *Ctrl+N*) sont énumérés ici à titre de référence, mais se modifient dans *Règles de création* dans #wikilink("2 - Paramètres"). Voyez #wikilink("3 - Raccourcis clavier") pour la référence complète.

== Modes sans distraction, focus et machine à écrire

Ce sont trois façons distinctes de calmer l'écran, et vous pouvez les combiner :

- Le *Mode sans distraction* masque certains éléments de l'interface utilisateur (les barres latérales) et réduit la barre d'état dans le coin. Activez-le avec le bouton de la barre d'état ou *Ctrl+Shift+1*, et quittez-le avec *Esc*.
- Le *Mode focus* met doucement en surbrillance seulement la ligne ou la section sur laquelle vous travaillez. Dans les #wikilink("2 - Paramètres"), vous choisissez entre *Désactivé*, *Ligne* et *Section*. Un paramètre distinct, *Atténuer le texte hors focus*, estompe tout ce qui se trouve à l'extérieur de la zone ciblée ; il fonctionne aussi seul, avec le Mode focus désactivé, auquel cas il garde clair le paragraphe que vous êtes en train d'écrire.
- Le *Mode machine à écrire* garde la ligne que vous tapez épinglée au centre vertical de l'écran, pour que vos yeux restent au même endroit. C'est aussi un paramètre, et il est actif en mode Édition visuelle.

== Se déplacer au clavier

InkyCap divise la fenêtre en *régions* (la barre latérale, chaque panneau d'éditeur, le panneau de droite et la barre d'état) entre lesquelles vous pouvez vous déplacer sans la souris :

- *F6* / *Shift+F6* font défiler les régions visibles vers l'avant et vers l'arrière.
- *Ctrl+Shift+0* saute directement à l'éditeur.
- *Esc* depuis n'importe quelle région autre que l'éditeur vous y ramène.
- *Ctrl+PageDown* / *Ctrl+PageUp* font défiler les onglets propres au panneau ciblé.

Les menus d'InkyCap, y compris les menus contextuels et leurs sous-menus, se contrôlent au clavier : les touches fléchées parcourent les éléments, *Début* et *Fin* sautent au premier et au dernier, *Entrée* ou *Espace* choisit l'élément en surbrillance, et *Esc* ferme le menu. *Droite* ou *Entrée* entre dans un sous-menu et *Gauche* en ressort.

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
