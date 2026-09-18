#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Paramètres",
  description: "Une visite guidée de chaque onglet des Paramètres d'InkyCap : Vue d'ensemble, Éditeur, Langue, Apparence, Fichiers et liens, Citations, Importation/Exportation et sauvegarde, Règles de création, Comportement, Extensions, À propos.",
  tags: ("documentation",),
)

= Paramètres

Utilisez les Paramètres d'InkyCap pour adapter l'application à votre façon d'écrire. Vous pouvez changer la manière dont les notes s'ouvrent, choisir un style de citation, configurer des sauvegardes automatiques, ajuster les couleurs et les polices, et plus encore.

== Ouvrir les Paramètres

+ Allez-y directement en cliquant sur le bouton d'engrenage au bas de la barre d'outils de gauche ou en appuyant sur la combinaison de raccourci : `Ctrl+,`. Vous pouvez aussi ouvrir la palette de commandes (`Ctrl+P`) et choisir la commande *Paramètres*.
+ Le panneau des Paramètres s'ouvre avec une liste d'onglets sur le côté gauche et les contrôles de l'onglet choisi sur la droite.
+ Fermez-le avec le bouton *×*, la touche *Échap*, ou en cliquant sur la zone atténuée à l'extérieur du panneau.

#callout("info")[ Certains paramètres s'appliquent à InkyCap partout (ils sont _globaux à l'utilisateur_) ; d'autres ne s'appliquent qu'à la boîte de notes que vous avez ouverte. Tout ce qui est limité à la boîte de notes courante est marqué d'une petite pastille *« cette boîte de notes »* à côté de son étiquette. S'il n'y a pas de pastille, le paramètre est global (pour toutes vos boîtes de notes). ]

== Un mot sur « Réinitialiser aux valeurs par défaut »

Plusieurs onglets ont un bouton rouge *« Réinitialiser aux valeurs par défaut »* dans le pied de page. Il réinitialise _chaque_ groupe de paramètres que cet onglet possède (il peut inclure à la fois des paramètres globaux et des paramètres propres à la boîte de notes).

#callout("warning")[ Réinitialiser *Fichiers et liens* efface aussi les chemins de dossier de cette boîte de notes, et réinitialiser *Éditeur* efface vos préférences de correction orthographique (elles sont stockées avec les paramètres de l'éditeur). Utilisez ces boutons délibérément. ]

== Vue d'ensemble

- *Version* indique quelle version d'InkyCap vous exécutez. Les numéros de version ont trois parties (année, mois, parution) ; quand le dernier nombre est impair, vous êtes sur une version de développement et une pastille *« Version de développement »* apparaît. *inkycap.org* mène au site du projet.
- *Rechercher des mises à jour* vous permet de chercher une version plus récente sur demande. InkyCap est local d'abord, alors il n'établit aucune connexion réseau à moins que vous le lui demandiez (voyez l'onglet Comportement ci-dessous). Si une version plus récente existe, vous verrez « La version X est disponible au téléchargement. » avec les boutons *Télécharger* (la page de téléchargement), *Voir les versions* (la page des versions) et *Vérifier de nouveau*. Rien n'est jamais installé à votre place ; voyez #wikilink("2 - Installer InkyCap").
- La section *Aide* mène à *Documentation InkyCap*, ce qui ouvre ce manuel dans une nouvelle fenêtre.

=== Gestion des boîtes de notes

Cette section énumère chaque boîte de notes qu'InkyCap connaît sur votre ordinateur et vous permet d'en ajouter d'autres. Chaque rangée affiche le nom de la boîte de notes (renommez-la avec le crayon), son emplacement, et des boutons pour l'*Ouvrir*, l'*Afficher* (la révéler dans votre gestionnaire de fichiers), la *Déplacer* ou la *Retirer*.

#callout("important")[ Ajouter une boîte de notes avec *Nouvelle boîte de notes* et *Ajouter* l'inscrit dans la liste sans l'ouvrir ; utilisez le bouton *Ouvrir* de la rangée quand vous êtes prêt. *Cloner depuis un dépôt distant* et *Importer un package*, en revanche, ouvrent la nouvelle boîte de notes dès qu'ils ont terminé (leurs boutons se lisent *Cloner et ouvrir* et *Importer et ouvrir*). ]

Vous pouvez aussi :

- *Nouvelle boîte de notes*. Choisissez un emplacement et un nom d'affichage facultatif, puis *Ajouter*.
- *Cloner depuis un dépôt distant*. Joignez-vous à une boîte de notes partagée et collaborative en clonant son dépôt git (adresse, branche, et nom d'utilisateur/mot de passe facultatifs). Voyez #wikilink("1 - Collaboration").
- *Importer un package*. Joignez-vous à une boîte de notes qui a été partagée sous forme de fichier package.

Chaque rangée comporte aussi un bouton *Collaboration* pour que vous puissiez créer une boîte de notes partagée. L'activer fait apparaître un bouton *Configurer* et un avis de fonctionnalité expérimentale.

== Éditeur

Ces paramètres globaux façonnent la sensation de la surface d'écriture.

- *Longueur de ligne confortable* limite la largeur des lignes pour une lecture plus facile ; l'activer vous permet de définir une *Longueur de ligne maximale*.
- *Appariement automatique des parenthèses* ferme les crochets et les guillemets pour vous à mesure que vous tapez. *Appariement automatique du balisage Typst* est son pendant pour les marques propres à Typst : avec du texte sélectionné, taper `*`, `_`, un accent grave ou `$` enveloppe la sélection, et taper un accent grave le ferme en paire.
- *Développement automatique du balisage* révèle le Typst sous-jacent, dans l'éditeur visuel, quand votre curseur entre dans une pastille.
- *Indentation de liste intuitive* signifie que Tab et Shift-Tab déplacent aussi les enfants imbriqués d'un élément de liste.
- *La touche Entrée insère un saut de ligne*. Dans l'éditeur visuel, une fois sur Entrée crée un saut de ligne léger et deux fois sur Entrée commence un nouveau paragraphe.
- *Préférence de mode d'édition* détermine si les notes s'ouvrent en *Édition visuelle* ou en *Mode source* par défaut (voyez #wikilink("2 - Modifier des notes")).
- *Mode machine à écrire* (garde le curseur au centre de la page), *Mode focus* (Désactivé / Ligne / Section) et *Atténuer le texte hors focus* vous aident à vous concentrer sur la ligne ou la section courante.

Sous *Commodités du mode visuel*, vous trouverez la *Barre d'outils contextuelle sur le texte sélectionné* et le #strong[Raccourci de commande barre oblique /] (tapez `/` pour une palette de mise en forme rapide). InkyCap vous avertit si vous désactivez les deux, puisque c'est par là que vous atteignez plusieurs commodités de l'éditeur visuel.

== Langue

- *Langue de l'interface* choisit la langue des menus et des boutons d'InkyCap. Le contenu de vos notes n'est pas touché, et le panneau se redessine en direct quand vous changez.
- *Utiliser la composition typographique de la langue* fait en sorte que les nouvelles notes suivent les règles typographiques de la langue de l'interface (coupure des mots, espacement et guillemets) quand elles sont compilées. Pour ce faire, une ligne `#set text(lang, region)` est ajoutée juste après la ligne d'importation en haut de chaque nouvelle note ; l'éditeur visuel garde cette ligne hors de vue, mais vous pouvez la voir en mode Édition source. Les notes existantes sont laissées exactement telles quelles, et désactiver l'option garde les nouvelles notes neutres quant à la langue.
- *Vérification orthographique* vérifie l'orthographe à mesure que vous tapez à l'aide de dictionnaires Hunspell intégrés ; les fautes sont soulignées et un clic droit offre des suggestions. Quand elle est activée, vous pouvez activer un ou plusieurs *Dictionnaires* (pratique pour les notes bilingues, où un mot est accepté si un dictionnaire activé le connaît) et *Installer des dictionnaires* en déposant vos propres fichiers.
- *Dictionnaire personnel* est la liste, propre à chaque boîte de notes, des mots que vous avez choisi d'accepter. Ils sont reconnus dans toute la boîte de notes par la correction orthographique et la détection de concepts, et ils voyagent avec elle.

== Apparence <appearance>

Ces paramètres touchent l'_interface_ d'InkyCap, pas vos documents compilés (sauf les *Valeurs de rendu par défaut* regroupées vers le bas).

- *Thème* (Clair / Sombre / Suivre le système) et des variantes d'*Arrière-plan* clair/sombre correspondantes.
- *Couleur d'accent* offre Par défaut, une couleur Personnalisée, ou Suivre le système.
- Des rôles de police pour les textes de l'*Interface*, de l'*Éditeur*, à *chasse fixe* et des *vers*, en plus de la *Taille de la police de l'éditeur* et d'une *Échelle de l'interface utilisateur*.
- *Cible du raccourci de zoom* détermine si Ctrl+/Ctrl- ajuste le contenu, l'interface ou les deux.
- *Regroupement des dossiers dans l'arborescence* place les dossiers avant les fichiers, après les fichiers, ou les mélange.
- *Format de date* détermine comment les dates apparaissent dans toute l'interface (agenda, heures de sauvegarde, la ligne « Dernière sauvegarde »). Cela ne change pas les noms de fichiers de sauvegarde ni les dates stockées dans vos notes.

=== Valeurs de rendu par défaut

Celles-ci touchent à la fois la sortie compilée (par exemple l'exportation PDF) et le mode lecture. Elles peuvent être remplacées par collection ou par note.

- *Préférence de format du mode lecture* offre *SVG* (précis, paginé mais affiché comme une image) ou *HTML* (texte copiable mais moins précis).
- *Afficher les liens wiki en ligne* et *Afficher les étiquettes en ligne* dans la sortie rendue.
- *Police de texte*, *Taille du texte* et *Format de page* (A4, US Letter, A5, et plus) pour les documents compilés. Voyez #wikilink("3 - Exportation et publication").

== Fichiers et liens

- *Emplacement des nouvelles notes* (cette boîte de notes) détermine où les nouvelles notes sont créées : la racine de la boîte de notes, le dossier actuel, ou un dossier spécifié (ce qui révèle un chemin *Dossier des nouvelles notes*).
- *Dossier des pièces jointes* (cette boîte de notes) détermine où sont stockées les images et les pièces glissées, collées ou importées. Le changer avec *Renommer le dossier…* déplace les fichiers existants et réécrit chaque référence à ceux-ci dans toute la boîte de notes.
- *Mettre à jour les liens automatiquement au renommage* garde vos liens wiki pointant au bon endroit quand un fichier est renommé (voyez #wikilink("4 - Liens et rétroliens")).
- *Confirmer avant de supprimer* et *Afficher les extensions de nom de fichier dans l'arborescence* contrôlent le comportement quotidien de l'arborescence.

Sous *Identifiants Zettelkasten*, *Activer les identifiants Zettelkasten* fait en sorte qu'InkyCap attribue à chaque nouvelle note une propriété `zid` unique construite à partir du *Motif d'identifiant Zettelkasten* (un motif de date et d'heure ; la valeur par défaut est `YYYYMMDDHHmmss`). *Titrer automatiquement les nouvelles notes avec le ZID* va un pas plus loin et utilise cet identifiant comme nom de fichier automatique pour les nouvelles notes, de sorte que vous n'avez pas besoin de les nommer.

Sous *Maintenance*, *Reconstruire le cache* (avec son bouton *Reconstruire*) relit chaque note depuis le disque et reconstruit à partir de zéro les index des rétroliens, des étiquettes et des propriétés, de la recherche et de la Vue mycélienne. InkyCap les garde à jour de lui-même, alors vous n'en avez besoin que pour vous remettre d'une information périmée, par exemple après avoir modifié des notes dans un autre programme pendant qu'InkyCap était fermé. Sur une grande boîte de notes de quelques milliers de notes, cela peut prendre quelques minutes.

== Citations

Cet onglet indique à InkyCap d'où viennent vos références et de quoi elles devraient avoir l'air. Pour le flux de travail complet, voyez #wikilink("7 - Citations et bibliographie").

- *Source des citations* (cette boîte de notes) est un *Fichier de bibliographie* (`.bib`, `.yml`, `.json`) ou une *Base de données Zotero*. Pour un fichier, vous pouvez le *Parcourir* ; pour Zotero, vous pouvez *Détecter* le chemin de la base de données.
- *Style de citation* est un style intégré (le style par défaut est *Chicago (auteur-date)* ; APA, MLA, IEEE et bien d'autres sont disponibles) ou un *Fichier CSL personnalisé* à vous (cette boîte de notes). Cela peut être remplacé par fichier ou par collection dans la sortie rendue.

== Importation/Exportation et sauvegarde

Cet onglet (intitulé *Paramètres d'importation et d'exportation*) configure l'importation de notes, l'assistant Pandoc et les sauvegardes automatiques.

- *Importer des fichiers Markdown* vous permet de pointer InkyCap vers une archive `.tar.gz` ou `.zip` de fichiers markdown, de choisir le dialecte *Standard* ou *Obsidian*, et de *Lancer l'importation*. Voyez #wikilink("2 - Importer des notes existantes").
- *Exportation* vous permet de définir un *Chemin de Pandoc* (ou de laisser InkyCap le détecter automatiquement) pour que vous puissiez exporter via Pandoc en plus des exportations Typst natives d'InkyCap.

#callout("note")[ Cet onglet ne configure que Pandoc et l'importation markdown. Les véritables actions d'exportation se trouvent dans le dialogue d'Exportation ailleurs (voyez #wikilink("3 - Exportation et publication")). ]

=== Sauvegardes

Sous *Sauvegarde de la boîte de notes*, activez *Sauvegarde et restauration de la boîte de notes* pour planifier des sauvegardes automatiques (et pour pouvoir restaurer à partir de l'une d'elles), puis réglez :

- *Dossier de destination* est un dossier à l'extérieur de votre boîte de notes.
- *Intervalle de sauvegarde (heures)* et *Conserver ce nombre de sauvegardes* déterminent à quelle fréquence sauvegarder et combien d'archives conserver.
- *Sauvegarder uniquement en cas de changement* et *Inclure le dossier des paramètres utilisateur* affinent ce qui est enregistré.
- *Motif de nom de fichier* est un gabarit utilisant des jetons comme `{notebox}`, `{YYYY}`, `{MM}` et `{DD}`.
- *Protection par mot de passe (optionnel)* chiffre chaque archive avec un mot de passe de votre choix, stocké de façon sécuritaire dans le trousseau de votre système d'exploitation. Utilisez *Définir le mot de passe*, *Mettre à jour le mot de passe* ou *Effacer le mot de passe* pour le gérer.

La ligne *Dernière sauvegarde* indique quand la plus récente archive a été créée, avec des boutons *Sauvegarder maintenant* et *Parcourir et restaurer…*.

#callout("warning")[ Chaque archive utilise le mot de passe qui était actif au moment de sa création. InkyCap ne stocke pas vos mots de passe. Si vous perdez le mot de passe, ces archives ne pourront pas être récupérées. InkyCap vous en avertit quand vous en définissez un. ]

== Règles de création

Les règles de création transforment la création répétitive de notes en un clic ou un raccourci. Cet onglet énumère vos règles et vous permet d'en ajouter de nouvelles avec *+ Nouvelle règle*. Pour la vue d'ensemble, voyez #wikilink("3 - Scaffolds, Templates et Packages"). Par exemple, aimez-vous mettre en forme vos notes avec des titres ou des étiquettes précis pour capturer des notes de cours ? Vous pourriez créer une règle de création Note de cours, qui vous permet de commencer une nouvelle note automatiquement mise en forme par un scaffold que vous définissez.

InkyCap fournit les règles de création intégrées *Nouvelle note* et *Note du jour*, que vous pouvez personnaliser, ou vous pouvez créer vos propres règles. Une règle peut préciser un nom et une icône, un *Modèle de nom de fichier* pour la nommer, un *Dossier cible* pour la ranger, un *Fichier scaffold* pour le contenu de départ, un *Template Typst*, un *Mode de création*, un *Raccourci clavier* facultatif, et si elle affiche un bouton dans la barre d'outils.

#callout("note")[ La règle *Nouvelle note* sous-tend le bouton Nouvelle note et `Ctrl+N`, alors elle ne peut être ni désactivée ni supprimée. ]

== Comportement

- *Comportement au démarrage* (global) détermine ce qu'InkyCap affiche à son ouverture : *Table rase (arborescence de fichiers)*, *Dernier fichier ouvert*, *Onglets précédemment ouverts*, *Lancer une règle*, *Ouvrir une page précise* ou *Ouvrir une collection précise* (ces dernières options ajoutent un sélecteur de cible pour la boîte de notes courante). *Onglets précédemment ouverts* ramène les onglets que vous aviez ouverts à la dernière fermeture de la boîte de notes, y compris celui qui était actif ainsi que le mode, le format et le zoom de chaque onglet ; cet enregistrement reste sur cet ordinateur et ne voyage jamais avec la boîte de notes.
- *Onglets*. *Passer immédiatement aux nouveaux onglets* détermine si un nouvel onglet prend le focus ou s'ouvre en arrière-plan.
- *Affichage*. *Composition GPU* utilise votre carte graphique pour dessiner l'interface et est activée par défaut. Désactivez-la si, sous Linux, vous voyez des éléments égarés ou dupliqués, des barres fantômes ou du texte résiduel ; cela se produit avec certaines combinaisons de carte graphique, de pilote et de bureau. Redémarrez InkyCap pour que le changement prenne effet.
- *Mises à jour du logiciel*. *Rechercher des mises à jour au démarrage* est *désactivé par défaut*, alors InkyCap n'établit aucune connexion réseau à moins que vous l'activiez ou vérifiiez manuellement. *Inclure les versions de développement (bêta)* vous informe aussi des versions préliminaires. Dans tous les cas, InkyCap vous indique seulement qu'une version est disponible ; l'installation vous revient (voyez #wikilink("2 - Installer InkyCap")).
- *Rouleau de journal* (cette boîte de notes). *Trier par* choisit l'axe selon lequel le fil est ordonné (*Date de création du fichier*, *Date de modification du fichier*, *Propriété zid de la note* ou *Propriété date de la note*), et *Portée de l'ancrage* fixe le plus grand ensemble de notes qu'il peut afficher (*Toutes les notes*, *Dossier des notes quotidiennes* ou *Dossier personnalisé*, qui ajoute un champ *Dossier de portée personnalisée*). Voyez #wikilink("4 - Rouleau de journal").

== Extensions

L'onglet Extensions vous permet d'enregistrer des programmes externes de confiance pour étendre InkyCap (par exemple un correcteur grammatical ou un script personnalisé). Pour le guide complet, voyez #wikilink("4 - Extensions").

#callout("warning")[ Cette fonctionnalité est expérimentale et pourrait ne pas fonctionner parfaitement. InkyCap ne fournit aucun outil de son propre cru ; vous enregistrez des exécutables de confiance. ]

Cliquez sur *Ajouter un outil* pour en enregistrer un. Chaque outil a :

- Un *Nom*, qui est la façon dont il apparaît dans les menus (par exemple « Vérification grammaticale »).
- Une *Commande* : le chemin complet du programme.
- Des *Arguments*, un par ligne. Trois espaces réservés sont remplis quand l'outil s'exécute : `$INKYCAP_NOTEBOX_ROOT` (le dossier de la boîte de notes), `$INKYCAP_FILE` (la note courante) et `$INKYCAP_SELECTION` (le texte sélectionné).
- *Envoyer à l'outil* : ce qu'InkyCap remet au programme comme entrée, soit le *Texte sélectionné*, la *Note entière* ou *Rien* (pour les outils qui reçoivent tout par les arguments).
- *Envoyer le texte brut seulement* : retire le balisage Typst, la ligne d'importation, les propriétés de la note, les mathématiques et le code pour que l'outil ne reçoive que votre prose. Idéal pour les correcteurs de grammaire et de style ; désactivez-le pour les outils qui ont besoin de la source Typst brute.
- *Utiliser le résultat* : quoi faire de ce que le programme renvoie, soit *Remplacer la sélection*, *Insérer au curseur*, *Afficher un message temporaire* ou *L'afficher dans un volet latéral*.
- *Afficher dans* : la *Palette de commandes*, le *Menu / de l'éditeur* ou *Les deux*. La palette garde votre sélection intacte, alors elle convient aux outils qui agissent sur du texte sélectionné ; le menu `/` remplace ce que vous avez tapé, alors il convient aux outils qui insèrent au curseur.

== À propos

L'onglet À propos est purement informatif. Il n'y a aucun paramètre ici.

- *À propos d'InkyCap* donne les droits d'auteur et les licences : le code sous la LiLiQ-P (Licence Libre du Québec, version permissive), la documentation sous Creative Commons CC BY-SA.
- *Logiciel libre et culture libre* crédite les polices, le moteur et l'outillage Typst, les bibliothèques de l'éditeur et de l'interface, les dictionnaires de correction orthographique, et plus encore, chacun avec une pastille de licence et un lien.
- *Afficher les mentions complètes* révèle les avis tiers complets pour les dépendances Rust et JavaScript.
\

== Pages connexes

- #wikilink("7 - Citations et bibliographie")
- #wikilink("3 - Scaffolds, Templates et Packages")
- #wikilink("4 - Extensions")
- #wikilink("3 - Exportation et publication")
- #wikilink("1 - Collaboration")
- #wikilink("1 - L'interface InkyCap")
- #wikilink("3 - Raccourcis clavier")
