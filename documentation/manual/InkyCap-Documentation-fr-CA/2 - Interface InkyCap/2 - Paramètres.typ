#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Paramètres",
  description: "Une visite guidée de chaque onglet des Paramètres d'InkyCap : Vue d'ensemble, Éditeur, Langue, Apparence, Fichiers, Citations, Exportation, Règles de création, Comportement, Extensions, À propos.",
  tags: ("documentation",),
)

= Paramètres

Utilisez les Paramètres d'InkyCap pour adapter l'application à votre façon d'écrire. Vous pouvez changer la manière dont les notes s'ouvrent, choisir un style de citation, configurer des sauvegardes automatiques, ajuster les couleurs et les polices, et plus encore.

== Ouvrir les Paramètres

+ Ouvrez la palette de commandes (`Ctrl+P`) et choisissez la commande *Paramètres* (elle se trouve sous la catégorie Affichage), ou allez-y directement en appuyant sur la combinaison de raccourci : `Ctrl+,`.
+ Le panneau s'ouvre avec une liste d'onglets sur le côté gauche et les contrôles de l'onglet choisi sur la droite.
+ Fermez-le avec le bouton *×*, la touche *Échap*, ou en cliquant sur la zone atténuée à l'extérieur du panneau.

#callout("info")[ Certains paramètres s'appliquent à InkyCap partout (ils sont _globaux à l'utilisateur_) ; d'autres ne s'appliquent qu'à la boîte de notes que vous avez ouverte. Tout ce qui est limité à la boîte de notes courante est marqué d'une petite pastille *« cette boîte de notes »* à côté de son étiquette. S'il n'y a pas de pastille, le paramètre est global (pour toutes vos boîtes de notes). ]

== Un mot sur « Réinitialiser aux valeurs par défaut »

Plusieurs onglets ont un bouton rouge *« Réinitialiser aux valeurs par défaut »* dans le pied de page. Il réinitialise _chaque_ groupe de paramètres que cet onglet possède (il peut inclure à la fois des paramètres globaux et des paramètres propres à la boîte de notes).

#callout("warning")[ Réinitialiser *Fichiers et liens* efface aussi les chemins de dossier de cette boîte de notes, et réinitialiser *Éditeur* efface vos préférences de correction orthographique (elles sont stockées avec les paramètres de l'éditeur). Utilisez ces boutons délibérément. ]

== Vue d'ensemble

- *Version* indique quelle version vous exécutez. Une pastille *« Version de développement »* apparaît sur les canaux bêta, et *inkycap.org* mène au site du projet.
- *Vérifier les mises à jour* vous permet de chercher une version plus récente sur demande. InkyCap est local d'abord, alors il n'établit aucune connexion réseau à moins que vous le lui demandiez (voyez l'onglet Comportement ci-dessous).
- La section *Aide* mène à *Documentation InkyCap*, ce qui ouvre ce manuel dans une nouvelle fenêtre.

=== Gestion des boîtes de notes

Cette section énumère chaque boîte de notes qu'InkyCap connaît sur votre ordinateur et vous permet d'en ajouter d'autres. Chaque rangée affiche le nom de la boîte de notes (renommez-la avec le crayon), son emplacement, et des boutons pour l'*Ouvrir*, l'*Afficher* (la révéler dans votre gestionnaire de fichiers), la *Déplacer* ou la *Retirer*.

#callout("important")[ Créer ou ajouter une boîte de notes ne l'ouvre *pas* automatiquement. Utilisez le bouton *Ouvrir* de la rangée. ]

Vous pouvez aussi :

- *Nouvelle boîte de notes*. Choisissez un emplacement et un nom d'affichage facultatif, puis *Ajouter*.
- *Cloner depuis un dépôt distant*. Joignez-vous à une boîte de notes partagée et collaborative en clonant son dépôt git (adresse, branche, et nom d'utilisateur/mot de passe facultatifs). Voyez #wikilink("1 - Collaboration").
- *Importer un package*. Joignez-vous à une boîte de notes qui a été partagée hors ligne sous forme de fichier package.

Chaque rangée comporte aussi un bouton *Collaboration*. L'activer fait apparaître un bouton *Configurer* et un avis de fonctionnalité expérimentale.

== Éditeur

Ces paramètres globaux façonnent la sensation de la surface d'écriture.

- *Longueur de ligne confortable* limite la largeur des lignes pour une lecture plus facile ; l'activer vous permet de définir une *Longueur de ligne maximale*.
- *Apparier automatiquement les crochets* et *Apparier automatiquement le balisage Typst* ferment automatiquement les crochets, les guillemets et les délimiteurs de balisage à mesure que vous tapez.
- *Déployer automatiquement le balisage* révèle le Typst sous-jacent, dans l'éditeur visuel, quand votre curseur entre dans une pastille.
- *Indentation de liste intuitive* signifie que Tab et Shift-Tab déplacent aussi les enfants imbriqués d'un élément de liste.
- *La touche Entrée insère un saut de ligne*. Dans l'éditeur visuel, une fois sur Entrée crée un saut de ligne léger et deux fois sur Entrée commence un nouveau paragraphe.
- *Préférence de mode d'édition* détermine si les notes s'ouvrent en *Édition visuelle* ou en *Mode source* par défaut (voyez #wikilink("2 - Modifier des notes")).
- *Mode machine à écrire* (garde le curseur au centre de la page), *Mode concentration* (Désactivé / Ligne / Section) et *Atténuer le texte hors concentration* vous aident à vous concentrer sur la ligne ou la section courante.

Sous *Commodités de l'éditeur visuel*, vous trouverez la *Barre d'outils contextuelle sur le texte sélectionné* et le *Raccourci de commande barre oblique* (tapez `/` pour une palette de mise en forme rapide). InkyCap vous avertit si vous désactivez les deux, puisque c'est par là que vous atteignez plusieurs commodités de l'éditeur visuel.

== Langue

- *Langue de l'interface* choisit la langue des menus et des boutons d'InkyCap. Le contenu de vos notes n'est pas touché, et le panneau se redessine en direct quand vous changez.
- *Correction orthographique* vérifie l'orthographe à mesure que vous tapez à l'aide de dictionnaires Hunspell intégrés ; les fautes sont soulignées et un clic droit offre des suggestions. Quand elle est activée, vous pouvez activer un ou plusieurs *Dictionnaires* (pratique pour les notes bilingues, où un mot est accepté si un dictionnaire activé le connaît) et *Installer des dictionnaires* en déposant vos propres fichiers.
- *Dictionnaire personnel* est la liste, propre à chaque boîte de notes, des mots que vous avez choisi d'accepter. Ils sont reconnus dans toute la boîte de notes par la correction orthographique et la détection de concepts, et ils voyagent avec elle.

== Apparence

Ces paramètres touchent l'_interface_ d'InkyCap, pas vos documents compilés (sauf les *Valeurs de rendu par défaut* regroupées vers le bas).

- *Thème* (Clair / Foncé / Suivre le système) et des variantes de *Fond* clair/foncé correspondantes.
- *Couleur d'accentuation* offre Par défaut, une couleur Personnalisée, ou Assortir au système d'exploitation.
- Des rôles de police pour les textes *Interface*, *Éditeur*, *Espacement fixe* et *Verset*, en plus de la *Taille de police de l'éditeur* et d'une *Échelle de l'interface utilisateur*.
- *Cible du raccourci de zoom* détermine si Ctrl+/Ctrl- ajuste le contenu, l'interface ou les deux.
- *Regroupement des dossiers dans l'arborescence* place les dossiers avant les fichiers, après les fichiers, ou les mélange.
- *Format de date* détermine comment les dates apparaissent dans toute l'interface (agenda, heures de sauvegarde, la ligne « Dernière sauvegarde »). Cela ne change pas les noms de fichiers de sauvegarde ni les dates stockées dans vos notes.

=== Valeurs de rendu par défaut

Celles-ci touchent à la fois la sortie compilée (par exemple l'exportation PDF) et le mode lecture. Elles peuvent être remplacées par collection ou par note.

- *Préférence de format du mode lecture* offre *SVG* (précis, paginé mais affiché comme une image) ou *HTML* (texte copiable mais moins précis).
- *Afficher les liens wiki en ligne* et *Afficher les étiquettes en ligne* dans la sortie rendue.
- *Police du texte*, *Taille du texte* et *Format de page* (A4, US Letter, A5, et plus) pour les documents compilés. Voyez #wikilink("3 - Exportation et publication").

== Fichiers et liens

- *Emplacement des nouvelles notes* (cette boîte de notes) détermine où les nouvelles notes sont créées : la racine de la boîte de notes, le dossier courant, ou un dossier précisé (ce qui révèle un chemin *Dossier des nouvelles notes*).
- *Dossier des pièces jointes* (cette boîte de notes) détermine où sont stockées les images et les pièces glissées, collées ou importées.
- *Mettre à jour automatiquement les liens lors d'un renommage* garde vos liens wiki pointant au bon endroit quand un fichier est renommé (voyez #wikilink("4 - Liens et rétroliens")).
- *Confirmer avant de supprimer* et *Afficher les extensions de fichiers dans l'arborescence* contrôlent le comportement quotidien de l'arborescence.

Sous *Identifiants Zettelkasten*, vous pouvez faire en sorte qu'InkyCap attribue automatiquement à chaque nouvelle note un `zid` unique basé sur un *motif* de date et d'heure, et optionnellement utiliser cet identifiant comme nom de fichier.

== Citations

Cet onglet indique à InkyCap d'où viennent vos références et de quoi elles devraient avoir l'air. Pour le flux de travail complet, voyez #wikilink("7 - Citations et bibliographie").

- *Source des citations* (cette boîte de notes) est un *Fichier de bibliographie* (`.bib`, `.yml`, `.json`) ou une *base de données Zotero*. Pour un fichier, vous pouvez le *Parcourir* ; pour Zotero, vous pouvez *Détecter* le chemin de la base de données.
- *Style de citation* est un style intégré (le style par défaut est *Chicago (auteur-date)* ; APA, MLA, IEEE et bien d'autres sont disponibles) ou un *fichier CSL personnalisé* à vous (cette boîte de notes). Cela peut être remplacé par fichier ou par collection dans la sortie rendue.

== Importation/Exportation et sauvegarde

Cet onglet configure l'importation de notes, l'assistant Pandoc et les sauvegardes automatiques.

- *Importer des fichiers markdown* vous permet de pointer InkyCap vers une archive `.tar.gz` ou `.zip` de fichiers markdown, de choisir le dialecte *Standard* ou *Obsidian*, et de *Lancer l'importation*. Voyez #wikilink("2 - Importer des notes existantes").
- *Exportation* vous permet de définir un *Chemin Pandoc* (ou de laisser InkyCap le détecter automatiquement) pour que vous puissiez exporter via Pandoc en plus des exportations Typst natives d'InkyCap.

#callout("note")[ Cet onglet ne configure que Pandoc et l'importation markdown. Les véritables actions d'exportation se trouvent dans le dialogue d'Exportation ailleurs (voyez #wikilink("3 - Exportation et publication")). ]

=== Sauvegardes

Activez *Activer* pour planifier des sauvegardes automatiques, puis réglez :

- *Destination* est un dossier à l'extérieur de votre boîte de notes.
- *Intervalle (heures)* et *Nombre à conserver* déterminent à quelle fréquence sauvegarder et combien d'archives conserver.
- *Sauvegarder seulement en cas de changement* et *Inclure la configuration de l'utilisateur* pour affiner ce qui est enregistré.
- *Motif de nom de fichier* est un gabarit utilisant des jetons comme `{notebox}`, `{YYYY}`, `{MM}` et `{DD}`.
- *Mot de passe* est un mot de passe facultatif qui chiffre chaque archive, stocké de façon sécuritaire dans le trousseau de votre système d'exploitation.

La ligne *Dernière sauvegarde* indique quand la plus récente archive a été créée, avec des boutons *« Sauvegarder maintenant »* et *« Parcourir et restaurer… »*.

#callout("warning")[ Chaque archive utilise le mot de passe qui était actif au moment de sa création. InkyCap ne stocke pas vos mots de passe. Si vous perdez le mot de passe, ces archives ne pourront pas être récupérées. InkyCap vous en avertit quand vous en définissez un. ]

== Règles de création

Les règles de création transforment la création répétitive de notes en un clic ou un raccourci. Cet onglet énumère vos règles et vous permet d'en ajouter de nouvelles avec *+ Nouvelle règle*. Pour la vue d'ensemble, voyez #wikilink("3 - Scaffolds, Templates et Packages"). Par exemple, aimez-vous mettre en forme vos notes avec des titres ou des étiquettes précis pour capturer des notes de cours ? Vous pourriez créer une règle de création Note de cours, qui vous permet de commencer une nouvelle note automatiquement mise en forme par un scaffold que vous définissez.

InkyCap est livré avec les règles intégrées *Nouvelle note* et *Note quotidienne*. Une règle peut préciser un nom et une icône, un *Motif de nom de fichier*, un *Dossier cible*, un *fichier Scaffold* pour le contenu de départ, un *template Typst*, un *Mode de création*, un *Raccourci* facultatif, et si elle affiche un bouton dans la barre d'outils.

#callout("note")[ La règle *Nouvelle note* sous-tend le bouton Nouvelle note et `Ctrl+N`, alors elle ne peut être ni désactivée ni supprimée. ]

== Comportement

- *Comportement au démarrage* (global) détermine ce qu'InkyCap affiche à son ouverture : l'arborescence de fichiers, votre dernier fichier, une règle lancée, ou une page ou collection précise (ces dernières options ajoutent un sélecteur de cible pour la boîte de notes courante).
- *Onglets*. *Passer immédiatement aux nouveaux onglets* détermine si un nouvel onglet prend le focus ou s'ouvre en arrière-plan.
- *Mises à jour logicielles*. *Vérifier les mises à jour au démarrage* est *désactivé par défaut*, alors InkyCap n'établit aucune connexion réseau à moins que vous l'activiez ou vérifiiez manuellement. Vous pouvez aussi adhérer aux versions de développement (bêta).
- *Rouleau de journal* (cette boîte de notes). *Trier par* et *Portée d'ancrage* contrôlent comment la vue continue du journal est assemblée. Voyez #wikilink("4 - Rouleau de journal").

== Extensions

L'onglet Extensions vous permet d'enregistrer des programmes externes de confiance pour étendre InkyCap (par exemple un correcteur grammatical ou un script personnalisé). Pour le guide complet, voyez #wikilink("4 - Extensions").

#callout("warning")[ Cette fonctionnalité est expérimentale et pourrait ne pas fonctionner parfaitement. InkyCap ne fournit aucun outil de son propre cru ; vous enregistrez des exécutables de confiance. ]

Chaque outil que vous ajoutez peut préciser une *Commande* (le chemin du programme), des *Arguments*, quel texte *Envoyer à l'outil*, comment *Utiliser le résultat*, et où l'*Afficher* (palette de commandes, menu de l'éditeur, ou les deux).

== À propos

L'onglet À propos est purement informatif. Il n'y a aucun paramètre ici.

- *À propos d'InkyCap* donne les droits d'auteur et les licences : le code sous la LiLiQ-P (Licence Libre du Québec – Permissive), la documentation sous Creative Commons CC BY-SA.
- *Logiciel libre et culture libre* crédite les polices, le moteur et l'outillage Typst, les bibliothèques de l'éditeur et de l'interface, les dictionnaires de correction orthographique, et plus encore, chacun avec une pastille de licence et un lien.
- *Afficher les avis complets* révèle les avis tiers complets pour les dépendances Rust et JavaScript.
\

== Pages connexes

- #wikilink("7 - Citations et bibliographie")
- #wikilink("3 - Scaffolds, Templates et Packages")
- #wikilink("4 - Extensions")
- #wikilink("3 - Exportation et publication")
- #wikilink("1 - Collaboration")
- #wikilink("1 - L'interface InkyCap")
- #wikilink("3 - Raccourcis clavier")
